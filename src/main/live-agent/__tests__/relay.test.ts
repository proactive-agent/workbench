/**
 * The relay (agent-flow's, run in the Live agent worker): a client gets the sessions run in its
 * own directory and nothing from other directories, and the relay advertises itself in the
 * project's .workbench/flow directory
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from '../relay/relay';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

// A test waits on up to two transcript reads of up to 5 s each: where fs.watch is late (macOS's
// FSEvents), a read can wait for the relay's 3 s poll, so the default 5 s per test isn't enough
describe('relay', { timeout: 20_000 }, () => {
  let root: string;
  let workspace: string;
  let otherDir: string;
  let flowDir: string;
  let transcript: string;
  let relay: Relay;
  const sent: Array<{ clientIds: string[]; message: { type: string; [key: string]: unknown } }> = [];
  /** The agent events sent to the clients so far */
  const events = () => sent
    .filter((entry) => entry.message.type === 'agent-event')
    .map((entry) => entry.message.event as { type: string; payload: Record<string, unknown> });
  /** Discovery files this relay wrote in the project's flow directory */
  const discoveryFiles = () =>
    (fs.existsSync(flowDir) ? fs.readdirSync(flowDir) : []).filter((file) => file.endsWith(`-${process.pid}.json`));

  beforeEach(async () => {
    sent.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-relay-')));
    workspace = path.join(root, 'project');
    otherDir = path.join(root, 'other');
    flowDir = path.join(workspace, '.workbench', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.mkdirSync(otherDir);
    const claudeDir = path.join(root, 'claude-config');
    const projectDir = path.join(claudeDir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const line = { type: 'user', uuid: 'u1', cwd: workspace, message: { role: 'user', content: 'Hello' } };
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify(line) + '\n');

    relay = await createRelay({
      claudeDirs: [claudeDir],
      send: (clientIds, data) => sent.push({ clientIds, message: JSON.parse(data) }),
    });
  });

  afterEach(() => {
    relay.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends a client the sessions run in its directory', () => {
    relay.subscribe('window-a', workspace, flowDir);

    const forA = sent.filter((entry) => entry.clientIds.includes('window-a')).map((entry) => entry.message);
    expect(forA.some((message) => message.type === 'session-started')).toBe(true);
    const batch = forA.find((message) => message.type === 'agent-event-batch');
    expect(batch).toMatchObject({ sessionId: SESSION_ID });

    // Advertised to the project's hook script, next to it in the flow directory
    expect(discoveryFiles()).toHaveLength(1);
    const discovery = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    expect(discovery).toMatchObject({ pid: process.pid, workspace });
  });

  it('sends a client nothing from sessions run elsewhere', () => {
    relay.subscribe('window-b', otherDir, flowDir);
    relay.subscribe('window-a', workspace, flowDir);

    expect(sent.some((entry) => entry.clientIds.includes('window-b'))).toBe(false);
  });

  it('replays the history to a client that subscribes later', () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    relay.subscribe('window-c', workspace, flowDir);

    const forC = sent.filter((entry) => entry.clientIds.includes('window-c')).map((entry) => entry.message.type);
    expect(forC).toEqual(['session-list', 'agent-event-batch']);
  });

  it('tells clients which agent window a session runs in, as its hooks report it', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID, hook_event_name: 'UserPromptSubmit', cwd: workspace, workbench_terminal_id: 'terminal-1',
      }),
    });

    const owners = sent.filter((entry) => entry.message.type === 'session-owner');
    expect(owners).toEqual([{ clientIds: ['window-a'], message: { type: 'session-owner', sessionId: SESSION_ID, owner: 'terminal-1' } }]);

    // A client that subscribes later learns it from the session list
    sent.length = 0;
    relay.subscribe('window-c', workspace, flowDir);
    const list = sent.find((entry) => entry.message.type === 'session-list');
    expect(list?.message.sessions).toEqual([expect.objectContaining({ id: SESSION_ID, owner: 'terminal-1' })]);
  });

  it('draws a background agent the session started (/subtask) and completes it on its report', async () => {
    // Claude Code runs /subtask as an agent of the session: no Agent tool call, an
    // informational line naming it, its own transcript under subagents/, and a
    // <task-notification> when it is done
    const agentId = 'aanalyze-the-deps-3dc25cd955d35ae1';
    const append = (entry: Record<string, unknown>) =>
      fs.appendFileSync(transcript, JSON.stringify({ cwd: workspace, ...entry }) + '\n');
    const subagentsDir = path.join(path.dirname(transcript), SESSION_ID, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    relay.subscribe('window-a', workspace, flowDir);
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    sent.length = 0;

    append({ type: 'system', subtype: 'informational', content: 'Started in the background: analyze the deps', launchedAgentId: agentId });
    // Its own transcript, as Claude Code writes it (the sidecar names no launching tool call)
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'fork', isFork: true, description: 'analyze the deps', finished: false })
    );
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), JSON.stringify({
      type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read' }] },
    }) + '\n');
    // Past SCAN_INTERVAL_MS: where fs.watch delivers late (macOS), the scan tick is what finds the file
    await vi.waitFor(
      () => expect(events().some((event) => event.type === 'tool_call_start')).toBe(true),
      { timeout: 5000 }
    );

    // Its node is the session's, drawn apart from ordinary sub-agents, and its work hangs off it
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_spawn', payload: { name: agentId, parent: 'orchestrator', satellite: true } }),
      expect.objectContaining({ type: 'tool_call_start', payload: expect.objectContaining({ agent: agentId, tool: 'Read' }) }),
    ]));
    expect(events().some((event) => event.type === 'agent_complete')).toBe(false);

    // Its hooks don't end it: a /subtask fork keeps working past its SubagentStop, and the
    // Stop it fires is its own turn ending, not the main agent's
    const hook = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, cwd: workspace, transcript_path: transcript, ...body }),
    });
    await hook({ hook_event_name: 'SubagentStop', agent_id: agentId });
    await hook({ hook_event_name: 'Stop', agent_id: agentId });
    expect(events().some((event) => event.type === 'agent_complete')).toBe(false);

    // It reports back when it is done
    append({
      type: 'user', uuid: 'u2',
      message: { role: 'user', content: `<task-notification>\n<task-id>${agentId}</task-id>\n</task-notification>` },
    });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_complete', payload: { name: agentId } }),
      ])),
      { timeout: 5000 }
    );
  });

  it('gives no node to a sub-agent handing its report back (SubagentHandback)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    const preToolUse = (tool: string, id: string) => fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'PreToolUse', cwd: workspace, tool_name: tool, tool_use_id: id }),
    });
    await preToolUse('SubagentHandback', 'toolu_handback');
    await preToolUse('Read', 'toolu_read');

    const started = sent
      .filter((entry) => entry.message.type === 'agent-event')
      .map((entry) => entry.message.event as { type: string; payload: { tool?: string } })
      .filter((event) => event.type === 'tool_call_start')
      .map((event) => event.payload.tool);
    expect(started).toEqual(['Read']);
  });

  /** Append transcript lines, have a hook read them, and return the agent events sent meanwhile */
  async function appendAndRead(lines: object[]): Promise<string[]> {
    fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    sent.length = 0;
    // A hook reads the transcript's new lines first (one the hook server passes
    // on, so this doesn't wait for fs.watch, which is slow on macOS)
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: workspace }),
    });
    return sent
      .filter((entry) => entry.message.type === 'agent-event')
      .map((entry) => (entry.message.event as { type: string }).type)
      .filter((type) => type !== 'permission_requested');
  }

  const reply = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'The sleeper finished.' }] } };
  const turnEnd = { type: 'system', subtype: 'turn_duration' };
  const notification = {
    type: 'user', uuid: 'n1',
    message: { role: 'user', content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n</task-notification>' },
  };

  it('keeps the main agent done when a handed-back sub-agent\'s notification arrives after its turn (2.1.300+)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    // The sub-agent's report (SubagentHandback) starts a turn, which ends; the
    // <task-notification> is written afterwards, and nothing answers it
    const handback = {
      type: 'user', uuid: 'p1', isMeta: true,
      origin: { kind: 'peer', from: 'task-1', senderTaskId: 'task-1', handback: true },
      message: { role: 'user', content: 'Another Claude session sent a message: slept 1s' },
    };
    expect(await appendAndRead([handback, reply, turnEnd, notification])).toEqual(['message', 'agent_complete']);
  });

  it('wakes the main agent for a task notification it answers (before 2.1.300)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    await appendAndRead([reply, turnEnd]);
    // The notification itself starts the turn in which the agent replies
    expect(await appendAndRead([notification])).toEqual(['message']);
  });

  // ─── Calls and agents that end without a transcript result ─────────────────

  const hookPort = () => JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8')).port as number;
  const postHook = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${hookPort()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION_ID, cwd: workspace, transcript_path: transcript, ...body }),
  });
  const appendTo = (file: string, entries: object[]) =>
    fs.appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const toolUse = (id: string, name = 'Bash') =>
    ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name }] } });
  const toolResult = (id: string, toolUseResult?: object) =>
    ({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult });
  /** Claude Code 2.1.300+ records each API request's messages too, after the calls they hold were answered */
  const requestBlob = (id: string, name = 'Bash') =>
    ({ type: 'api-request-blob', hash: `h-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name }] } });
  const subagentsDir = () => path.join(path.dirname(transcript), SESSION_ID, 'subagents');

  it('draws no running calls for answered ones an API request record repeats', async () => {
    // The main agent's and a sub-agent's history, each with answered calls its request records repeat
    appendTo(transcript, [toolUse('toolu_main'), toolResult('toolu_main'), requestBlob('toolu_main')]);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const subagentFile = path.join(subagentsDir(), 'agent-averifier.jsonl');
    fs.writeFileSync(path.join(subagentsDir(), 'agent-averifier.meta.json'), JSON.stringify({ toolUseId: 'toolu_unknown_launch' }));
    appendTo(subagentFile, [toolUse('toolu_sub'), toolResult('toolu_sub'), requestBlob('toolu_sub'), requestBlob('toolu_sub_read', 'Read')]);

    relay.subscribe('window-a', workspace, flowDir);

    expect(events().filter((event) => event.type === 'tool_call_start')).toEqual([]);
    // The sub-agent is done with its calls: nothing of it is drawn
    expect(events().some((event) => event.type === 'agent_spawn' && event.payload.name === 'toolu_unknown_launch')).toBe(false);
  });

  it('ends a call on its PostToolUse / PostToolUseFailure hook, before (or without) its transcript result', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    await postHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_ok' });
    await postHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_bad' });
    await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_ok' });
    await postHook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_bad' });
    // The transcript's results, written later, don't end them again
    appendTo(transcript, [toolUse('toolu_ok'), toolResult('toolu_ok'), toolResult('toolu_bad')]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });

    const ends = events().filter((event) => event.type === 'tool_call_end').map((event) => event.payload);
    expect(ends).toEqual([
      { agent: 'orchestrator', tool: 'Bash', id: 'toolu_ok' },
      { agent: 'orchestrator', tool: 'Bash', id: 'toolu_bad', isError: true },
    ]);
  });

  it('ends the main agent\'s turn on StopFailure (an API error such as a rate limit)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    await postHook({ hook_event_name: 'StopFailure', error: 'rate_limit' });
    expect(events()).toEqual([expect.objectContaining({ type: 'agent_complete', payload: { name: 'orchestrator' } })]);
  });

  it('finishes a foreground sub-agent its caller\'s turn ended without (interrupted), with the ones it waited on', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    appendTo(transcript, [toolUse('toolu_agent', 'Agent')]);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    fs.writeFileSync(path.join(subagentsDir(), 'agent-aworker.meta.json'), JSON.stringify({ toolUseId: 'toolu_agent' }));
    appendTo(path.join(subagentsDir(), 'agent-aworker.jsonl'), [toolUse('toolu_nested', 'Agent'), toolUse('toolu_sub_bash')]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events().some((event) => event.type === 'agent_spawn' && event.payload.name === 'toolu_nested')).toBe(true),
      { timeout: 5000 }
    );
    sent.length = 0;

    appendTo(transcript, [{ type: 'user', uuid: 'u-int', message: { role: 'user', content: '[Request interrupted by user]' } }]);
    await postHook({ hook_event_name: 'Stop' });

    const completed = events().filter((event) => event.type === 'agent_complete').map((event) => event.payload.name);
    expect(completed).toEqual(['toolu_nested', 'toolu_agent', 'orchestrator']);
  });

  it('completes a forked skill typed at the prompt (/code-review) on its report', async () => {
    const agentId = 'a6d29d2cb8fa223f7';
    relay.subscribe('window-a', workspace, flowDir);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review' }));
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', name: 'code-review', requestShape: 'background' }));
    appendTo(path.join(subagentsDir(), `agent-${agentId}.jsonl`), [toolUse('toolu_typed_read', 'Read')]);
    // Typed rather than called: no Skill call, only the command's output with its marker
    appendTo(transcript, [{
      type: 'system', subtype: 'local_command', level: 'info',
      content: '<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n'
        + `<forked-skill-launch>{"agentId":"${agentId}","skillName":"code-review","description":"/code-review medium"}</forked-skill-launch>`,
    }]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_spawn', payload: { name: agentId, parent: 'orchestrator', satellite: true } }),
      ])),
      { timeout: 5000 }
    );

    // Its report, as Claude Code records it: queued, then handed to the session
    sent.length = 0;
    const report = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>`;
    appendTo(transcript, [
      { type: 'queue-operation', operation: 'enqueue', content: report },
      { type: 'user', uuid: 'u-report', origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: report } },
    ]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_complete', payload: { name: agentId } }),
      ])),
      { timeout: 5000 }
    );
  });

  it('keeps a background agent a sub-agent launches running until its report', async () => {
    // /code-review's fork sends its reviewers out in the background. Its transcript records each
    // launch's result without a toolUseResult, only the Agent tool's answer
    const agentId = 'a32c2c04160aaa861';
    relay.subscribe('window-a', workspace, flowDir);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const forkFile = path.join(subagentsDir(), `agent-${agentId}.jsonl`);
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review' }));
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', name: 'code-review' }));
    appendTo(transcript, [
      toolUse('toolu_review', 'Skill'),
      toolResult('toolu_review', { success: true, status: 'forked', background: true, agentId }),
    ]);
    appendTo(forkFile, [
      toolUse('toolu_reviewer', 'Agent'),
      {
        type: 'user', uuid: 'r-reviewer', isSidechain: true,
        message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'toolu_reviewer',
          content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a8777609eb4aa278e\nThe agent is working in the background.' }],
        }] },
      },
    ]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_spawn', payload: expect.objectContaining({ name: 'toolu_reviewer', parent: agentId }) }),
      ])),
      { timeout: 5000 }
    );
    // Launched is not done: it goes on working in the background
    expect(events().some((event) => event.type === 'agent_complete' && event.payload.name === 'toolu_reviewer')).toBe(false);

    // Its report, which the fork is handed, is what ends it
    appendTo(forkFile, [{
      type: 'queue-operation', operation: 'enqueue',
      content: '<task-notification>\n<task-id>a8777609eb4aa278e</task-id>\n<tool-use-id>toolu_reviewer</tool-use-id>\n<status>completed</status>\n</task-notification>',
    }]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_complete', payload: { name: 'toolu_reviewer' } }),
      ])),
      { timeout: 5000 }
    );
  });

  it('keeps a background agent a sub-agent launched before the relay attached running until its report', async () => {
    // As above, but all of it is on disk when the relay attaches: the fork's file is pre-scanned
    // rather than read as it comes
    const agentId = 'a32c2c04160aaa861';
    const reviewerId = 'a8777609eb4aa278e';
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const forkFile = path.join(subagentsDir(), `agent-${agentId}.jsonl`);
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review' }));
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', name: 'code-review' }));
    appendTo(transcript, [
      toolUse('toolu_review', 'Skill'),
      toolResult('toolu_review', { success: true, status: 'forked', background: true, agentId }),
    ]);
    appendTo(forkFile, [
      toolUse('toolu_reviewer', 'Agent'),
      {
        type: 'user', uuid: 'r-reviewer', isSidechain: true,
        message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'toolu_reviewer',
          content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${reviewerId}\nThe agent is working in the background.` }],
        }] },
      },
    ]);
    fs.writeFileSync(path.join(subagentsDir(), `agent-${reviewerId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_reviewer' }));
    appendTo(path.join(subagentsDir(), `agent-${reviewerId}.jsonl`), [toolUse('toolu_reviewer_read', 'Read')]);

    relay.subscribe('window-a', workspace, flowDir);
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_spawn', payload: expect.objectContaining({ name: 'toolu_reviewer', parent: agentId }) }),
    ]));
    expect(events().some((event) => event.type === 'agent_complete' && event.payload.name === 'toolu_reviewer')).toBe(false);

    appendTo(forkFile, [{
      type: 'queue-operation', operation: 'enqueue',
      content: `<task-notification>\n<task-id>${reviewerId}</task-id>\n<tool-use-id>toolu_reviewer</tool-use-id>\n<status>completed</status>\n</task-notification>`,
    }]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_complete', payload: { name: 'toolu_reviewer' } }),
      ])),
      { timeout: 5000 }
    );
  });

  it('draws a nested agent found before its launcher at attach under that launcher', async () => {
    // The reviewer's file sorts before its fork's, so it is read first: its launch is only recorded
    // once the fork's file is pre-scanned
    const agentId = 'a87c2c04160aaa861';
    const reviewerId = 'a3277609eb4aa278e';
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const forkFile = path.join(subagentsDir(), `agent-${agentId}.jsonl`);
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review' }));
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', name: 'code-review' }));
    appendTo(transcript, [
      toolUse('toolu_review', 'Skill'),
      toolResult('toolu_review', { success: true, status: 'forked', background: true, agentId }),
    ]);
    appendTo(forkFile, [
      toolUse('toolu_reviewer', 'Agent'),
      {
        type: 'user', uuid: 'r-reviewer', isSidechain: true,
        message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'toolu_reviewer',
          content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${reviewerId}\nThe agent is working in the background.` }],
        }] },
      },
      // A foreground reviewer that already reported back
      toolUse('toolu_done', 'Agent'),
      { type: 'user', uuid: 'r-done', isSidechain: true, message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_done', content: [{ type: 'text', text: 'No issues found' }],
      }] } },
    ]);
    // Written for the foreground at request time; its answer says it went to the background
    fs.writeFileSync(path.join(subagentsDir(), `agent-${reviewerId}.meta.json`), JSON.stringify({ toolUseId: 'toolu_reviewer', requestShape: 'foreground' }));
    appendTo(path.join(subagentsDir(), `agent-${reviewerId}.jsonl`), [toolUse('toolu_reviewer_read', 'Read')]);
    fs.writeFileSync(path.join(subagentsDir(), 'agent-a1111111111111111.meta.json'), JSON.stringify({ toolUseId: 'toolu_done', requestShape: 'foreground' }));
    appendTo(path.join(subagentsDir(), 'agent-a1111111111111111.jsonl'), [toolUse('toolu_done_read', 'Read')]);

    relay.subscribe('window-a', workspace, flowDir);
    const spawns = events().filter((event) => event.type === 'agent_spawn');
    expect(spawns).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ name: 'toolu_reviewer', parent: agentId }) }),
    ]));
    expect(spawns.some((event) => event.payload.name === 'toolu_reviewer' && event.payload.parent !== agentId)).toBe(false);
    expect(spawns.some((event) => event.payload.name === 'toolu_done')).toBe(false);
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_call_start', payload: expect.objectContaining({ agent: 'toolu_reviewer', id: 'toolu_reviewer_read' }) }),
    ]));
    expect(events().some((event) => event.type === 'agent_complete' && event.payload.name === 'toolu_reviewer')).toBe(false);
  });

  it('draws a forked skill\'s background agent (/code-review) and completes it on its report', async () => {
    const agentId = 'aedfe971f6aff305a';
    relay.subscribe('window-a', workspace, flowDir);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const forkFile = path.join(subagentsDir(), `agent-${agentId}.jsonl`);
    // As Claude Code writes it: a sidecar marks the forked skill, its .meta.json names no launching call
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.forked-skill.json`), JSON.stringify({ skillName: 'code-review' }));
    fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', name: 'code-review', requestShape: 'background' }));
    appendTo(forkFile, [toolUse('toolu_verifier', 'Agent')]);
    appendTo(transcript, [
      toolUse('toolu_skill', 'Skill'),
      toolResult('toolu_skill', { success: true, status: 'forked', background: true, agentId }),
    ]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_spawn', payload: { name: agentId, parent: 'orchestrator', satellite: true } }),
        // Its own sub-agents hang off it, not off the main agent
        expect.objectContaining({ type: 'agent_spawn', payload: expect.objectContaining({ name: 'toolu_verifier', parent: agentId }) }),
      ])),
      { timeout: 5000 }
    );

    // Its calls, reported by its hooks, are its own
    sent.length = 0;
    await postHook({ hook_event_name: 'PreToolUse', agent_id: agentId, tool_name: 'Bash', tool_use_id: 'toolu_fork_bash' });
    expect(events()).toEqual([
      expect.objectContaining({ type: 'tool_call_start', payload: { agent: agentId, tool: 'Bash', id: 'toolu_fork_bash' } }),
    ]);

    // Its report names its Skill call and its agent
    appendTo(transcript, [{
      type: 'queue-operation', operation: 'enqueue',
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_skill</tool-use-id>\n<status>failed</status>\n</task-notification>`,
    }]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent_complete', payload: { name: agentId } }),
    ]));
  });

  it('finishes a sub-agent stopped by an API error (StopFailure inside it)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    appendTo(transcript, [toolUse('toolu_bg', 'Agent'), toolResult('toolu_bg', { status: 'async_launched' })]);
    fs.writeFileSync(path.join(subagentsDir(), 'agent-abg.meta.json'), JSON.stringify({ toolUseId: 'toolu_bg' }));
    appendTo(path.join(subagentsDir(), 'agent-abg.jsonl'), [toolUse('toolu_bg_bash')]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events().some((event) => event.type === 'tool_call_start' && event.payload.id === 'toolu_bg_bash')).toBe(true),
      { timeout: 5000 }
    );
    sent.length = 0;

    await postHook({ hook_event_name: 'StopFailure', agent_id: 'abg', error: 'rate_limit' });

    expect(events()).toEqual([expect.objectContaining({ type: 'agent_complete', payload: { name: 'toolu_bg' } })]);
  });

  it('takes a sub-agent whose transcript has long been quiet as stopped', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    fs.mkdirSync(subagentsDir(), { recursive: true });
    appendTo(transcript, [toolUse('toolu_quiet', 'Agent'), toolResult('toolu_quiet', { status: 'async_launched' })]);
    const file = path.join(subagentsDir(), 'agent-aquiet.jsonl');
    fs.writeFileSync(path.join(subagentsDir(), 'agent-aquiet.meta.json'), JSON.stringify({ toolUseId: 'toolu_quiet' }));
    appendTo(file, [toolUse('toolu_quiet_bash')]);
    await postHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    await vi.waitFor(
      () => expect(events().some((event) => event.type === 'tool_call_start' && event.payload.id === 'toolu_quiet_bash')).toBe(true),
      { timeout: 5000 }
    );
    expect(events().some((event) => event.type === 'agent_complete' && event.payload.name === 'toolu_quiet')).toBe(false);

    // Its file was last written an hour ago (its agent died without a word)
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(file, anHourAgo, anHourAgo);
    await vi.waitFor(
      () => expect(events()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'agent_complete', payload: { name: 'toolu_quiet' } }),
      ])),
      { timeout: 6000 }
    );
  }, 10000);

  it('writes no discovery file for a project with Live agent off', () => {
    fs.rmSync(flowDir, { recursive: true });
    relay.subscribe('window-a', workspace, flowDir);
    expect(fs.existsSync(flowDir)).toBe(false);
  });

  it('stops advertising a directory once no client shows it', () => {
    relay.subscribe('window-a', workspace, flowDir);
    relay.subscribe('window-c', workspace, flowDir);
    relay.unsubscribe('window-a');
    expect(discoveryFiles()).toHaveLength(1);
    relay.unsubscribe('window-c');
    expect(discoveryFiles()).toEqual([]);
  });

  it('dispose removes the discovery file', () => {
    relay.subscribe('window-a', workspace, flowDir);
    relay.dispose();
    expect(discoveryFiles()).toEqual([]);
  });
});

// Headless runs (`claude -p`: the Claude page's chats) share the project's transcript folder with the
// agent windows' sessions, and carry no agent window id: none of them is ever shown in a window
describe('relay and headless sessions', { timeout: 20_000 }, () => {
  const WINDOW_SESSION = '11111111-2222-3333-4444-555555555555';
  const CHAT_SESSION = '66666666-7777-8888-9999-000000000000';
  let root: string;
  let workspace: string;
  let flowDir: string;
  let projectDir: string;
  let relay: Relay;
  const sent: Array<{ clientIds: string[]; message: { type: string; [key: string]: unknown } }> = [];
  /** The ids of the sessions the relay announced */
  const announced = () => sent.flatMap((entry) => [
    ...(entry.message.type === 'session-started' ? [(entry.message.session as { id: string }).id] : []),
    ...(entry.message.type === 'session-list' ? (entry.message.sessions as Array<{ id: string }>).map((session) => session.id) : []),
  ]);
  const prompt = (entrypoint?: string) =>
    JSON.stringify({ type: 'user', uuid: 'u1', ...(entrypoint ? { entrypoint } : {}), cwd: workspace, message: { role: 'user', content: 'Hello' } }) + '\n';

  beforeEach(async () => {
    sent.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-relay-headless-')));
    workspace = path.join(root, 'project');
    flowDir = path.join(workspace, '.workbench', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    const claudeDir = path.join(root, 'claude-config');
    projectDir = path.join(claudeDir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    relay = await createRelay({
      claudeDirs: [claudeDir],
      send: (clientIds, data) => sent.push({ clientIds, message: JSON.parse(data) }),
    });
  });

  afterEach(() => {
    relay.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never sends a chat run in the project root, only the window\'s session', () => {
    fs.writeFileSync(path.join(projectDir, `${WINDOW_SESSION}.jsonl`), prompt('cli'));
    fs.writeFileSync(path.join(projectDir, `${CHAT_SESSION}.jsonl`), prompt('sdk-cli'));

    relay.subscribe('window-a', workspace, flowDir);

    expect(announced()).toContain(WINDOW_SESSION);
    expect(announced()).not.toContain(CHAT_SESSION);
  });

  it('shows a task\'s headless run in its worktree (a window following or resuming the task)', () => {
    const worktree = path.join(workspace, '.workbench', 'worktrees', 'tasks', '001-task');
    fs.mkdirSync(worktree, { recursive: true });
    const worktreeProjectDir = path.join(path.dirname(projectDir), worktree.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(worktreeProjectDir, { recursive: true });
    const taskRun = JSON.stringify({ type: 'user', uuid: 'u1', entrypoint: 'sdk-cli', cwd: worktree, message: { role: 'user', content: 'Hello' } }) + '\n';
    fs.writeFileSync(path.join(worktreeProjectDir, `${CHAT_SESSION}.jsonl`), taskRun);

    relay.subscribe('window-a', worktree, flowDir);

    expect(announced()).toContain(CHAT_SESSION);
  });

  it('shows a session whose transcript records no entrypoint (older Claude Code)', () => {
    fs.writeFileSync(path.join(projectDir, `${WINDOW_SESSION}.jsonl`), prompt());

    relay.subscribe('window-a', workspace, flowDir);

    expect(announced()).toContain(WINDOW_SESSION);
  });

  it('ignores a chat that starts while a window shows the directory', async () => {
    fs.writeFileSync(path.join(projectDir, `${WINDOW_SESSION}.jsonl`), prompt('cli'));
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;

    // A chat writes its name and queue entries before the prompt that says how it was run
    const chat = path.join(projectDir, `${CHAT_SESSION}.jsonl`);
    fs.writeFileSync(chat, JSON.stringify({ type: 'agent-name', agentName: 'Workbench chat: x', sessionId: CHAT_SESSION }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.appendFileSync(chat, prompt('sdk-cli'));
    // Scanned again on every change and every second
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(announced()).not.toContain(CHAT_SESSION);
  });
});
