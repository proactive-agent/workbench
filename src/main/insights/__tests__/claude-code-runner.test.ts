/**
 * Insights through Claude Code, exercised end-to-end against a fake `claude` CLI:
 * a Node script that records its argv/stdin/env and prints scripted stream-json events.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'insights-cc-test-'));
const fakeCli = join(workDir, 'fake-claude.cjs');
const recordFile = join(workDir, 'record.json');

writeFileSync(
  fakeCli,
  `
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.FAKE_RECORD + '.runs', JSON.stringify(args) + '\\n');
  if (process.env.FAKE_RESUME_FAILS && args.includes('--resume')) {
    process.stderr.write('No conversation found with session ID: ' + args[args.indexOf('--resume') + 1]);
    process.exit(1);
  }
  const promptFile = args[args.indexOf('--append-system-prompt-file') + 1];
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args,
    stdin,
    systemPrompt: fs.readFileSync(promptFile, 'utf8'),
    configDir: process.env.CLAUDE_CONFIG_DIR,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    graphifyOut: process.env.GRAPHIFY_OUT ?? null,
    mcpConfig: args.includes('--mcp-config') ? JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) : null,
    mcpToolTimeout: process.env.MCP_TOOL_TIMEOUT ?? null,
    mcpTimeout: process.env.MCP_TIMEOUT ?? null,
    bridgeSource: (() => {
      if (!args.includes('--mcp-config')) return null;
      const server = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.workbench;
      return server && server.type === 'stdio' ? fs.readFileSync(server.args[0], 'utf8') : null;
    })(),
  }));
  for (const event of JSON.parse(process.env.FAKE_EVENTS || '[]')) process.stdout.write(JSON.stringify(event) + '\\n');
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
  process.exit(Number(process.env.FAKE_EXIT || 0));
});
`,
);

let cliFound = true;
/** Version of the installed claude, as getToolInfoAsync reports it */
let cliVersion: string | undefined = '2.1.312';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // Run the fake CLI with the current Node binary (works on every platform)
    spawn: (_command: string, args: string[], options: Record<string, unknown>) =>
      actual.spawn(process.execPath, [fakeCli, ...args], { ...options, shell: false }),
  };
});
vi.mock('../../cli-tool-manager', () => ({
  getToolInfoAsync: async () => (cliFound ? { found: true, path: '/usr/bin/claude', version: cliVersion } : { found: false, message: 'Claude CLI not found' }),
}));
vi.mock('../../claude-code/env', () => ({
  resolveClaudeEnv: async () => ({
    command: '/usr/bin/claude',
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, GRAPHIFY_OUT: undefined, CLAUDE_CONFIG_DIR: '/profiles/main' },
    profileId: 'main',
  }),
}));
vi.mock('../../env-utils', () => ({
  getSpawnCommand: (command: string) => command,
  getSpawnOptions: (_command: string, options: Record<string, unknown>) => ({ ...options, shell: false }),
  shouldUseShell: () => false,
}));

/**
 * Claude Code in WSL, as far as the Insights runner decides (task tools, claude lookup). The fake
 * CLI itself still runs natively: spawning stays native (isWslRuntime false)
 */
const wslRef = vi.hoisted(() => ({
  info: null as null | { distro: string; networkingMode: string | null; interop?: boolean; tools: { claude: { path: string | null; version?: string | null } } },
  version: 2,
}));
/** Node.js on Windows while chat browsers run there (browser-runtime.ts) */
const windowsRef = vi.hoisted(() => ({ node: null as null | { node: string; npx: string; version: string } }));
vi.mock('../../browser-drawer/browser-runtime', () => ({ windowsNode: () => windowsRef.node }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => false,
  getWslInfo: () => wslRef.info,
  getShellRuntimeStatus: () => ({ wsl: wslRef.info ? { version: wslRef.version } : null }),
  toRuntimePath: (p: string) => (wslRef.info ? `/runtime${p.replace(/\\/g, '/')}` : p),
  toHostPath: (p: string) => p,
}));

import {
  runInsights,
  INSIGHTS_READ_ONLY_TOOLS,
  INSIGHTS_WEB_TOOLS,
  INSIGHTS_GRAPHIFY_COMMANDS,
  INSIGHTS_TASK_TOOLS_RULE,
  INSIGHTS_SESSION_MESSAGING_TOOLS,
  INSIGHTS_GITHUB_RULES,
  INSIGHTS_MEMORY_RULE,
  INSIGHTS_GITLAB_RULES,
  resetTaskToolsBridgeForTests,
  guardChatPlaywright,
  getTaskToolsRoute,
  CHAT_BROWSER_RELAY_ENV,
  supportsSystemPromptSnapshot,
  toClaudeModel,
  type InsightsStreamEvent,
} from '../claude-code-runner';
import { INSIGHTS_ERROR_CODES, parseInsightsError } from '../../../shared/constants/insights';

const delta = (index: number, d: Record<string, unknown>) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: d } });
const blockStart = (index: number, block: Record<string, unknown>) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });
const blockStop = (index: number) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });

const conversation = [
  { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'] },
  blockStart(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: 'Let me look.' }),
  blockStop(0),
  blockStart(1, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
  delta(1, { type: 'input_json_delta', partial_json: '{"file_path": "src/au' }),
  delta(1, { type: 'input_json_delta', partial_json: 'th.ts"}' }),
  blockStop(1),
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const auth = 1' }] } },
  blockStart(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: 'Auth uses JWT.' }),
  blockStop(0),
  { type: 'result', subtype: 'success', is_error: false, result: 'Auth uses JWT.' },
];

function setRun(events: unknown[], exitCode = 0, stderr = '') {
  rmSync(`${recordFile}.runs`, { force: true });
  delete process.env.FAKE_RESUME_FAILS;
  process.env.FAKE_EVENTS = JSON.stringify(events);
  process.env.FAKE_EXIT = String(exitCode);
  process.env.FAKE_STDERR = stderr;
  process.env.FAKE_RECORD = recordFile;
}

const record = () => JSON.parse(readFileSync(recordFile, 'utf8'));
/** The arguments of every run of the turn, in order */
const runs = (): string[][] => readFileSync(`${recordFile}.runs`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

async function run(overrides: Record<string, unknown> = {}) {
  const events: InsightsStreamEvent[] = [];
  const promise = runInsights(
    { projectDir: workDir, message: 'How does auth work?', model: 'claude-sonnet-4-6', thinkingLevel: 'high', ...overrides },
    (e) => events.push(e),
  );
  return { promise, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  cliFound = true;
  cliVersion = '2.1.312';
  wslRef.info = null;
  wslRef.version = 2;
  resetTaskToolsBridgeForTests();
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('runInsights', () => {
  it('streams text and tool activity and returns the answer', async () => {
    setRun(conversation);
    const { promise, events } = await run();
    const result = await promise;

    expect(result.text).toBe('Let me look.\n\nAuth uses JWT.');
    expect(result.toolCalls).toEqual([{ name: 'Read', input: 'src/auth.ts' }]);
    expect(events).toEqual([
      { type: 'text-delta', text: 'Let me look.' },
      { type: 'tool-start', name: 'Read', input: 'src/auth.ts' },
      { type: 'tool-end', name: 'Read' },
      { type: 'text-delta', text: '\n\n' },
      { type: 'text-delta', text: 'Auth uses JWT.' },
    ]);
  });

  it('runs the CLI read-only, headless and with the profile credentials', async () => {
    setRun(conversation);
    await (await run()).promise;
    const { args, configDir, apiKey, systemPrompt } = record();

    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    expect(args[args.indexOf('--tools') + 1]).toBe([...INSIGHTS_READ_ONLY_TOOLS, ...INSIGHTS_WEB_TOOLS].join(','));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args).toContain('--strict-mcp-config');
    // A new session (no session given): a fresh id, the conversation folded into the prompt
    expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).not.toContain('--resume');
    expect(systemPrompt).toContain('You are the Claude page of Workbench');
    expect(configDir).toBe('/profiles/main');
    expect(apiKey).toBeNull();
  });

  it('lets the CLI search the project memory graph with graphify commands only', async () => {
    setRun(conversation);
    await (await run({
      graphify: {
        prompt: 'CodebaseGraph tool section',
        commandPrompt: 'graphify commands section',
        cli: '/home/me/.local/bin/graphify',
        graph: '/project/.workbench/knowledge/graphify-out/graph.json',
      },
    })).promise;
    const { args, systemPrompt, graphifyOut } = record();

    expect(args[args.indexOf('--tools') + 1]).toBe([...INSIGHTS_READ_ONLY_TOOLS, ...INSIGHTS_WEB_TOOLS, 'Bash'].join(','));
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 1 + INSIGHTS_GRAPHIFY_COMMANDS.length);
    expect(allowed).toEqual([...INSIGHTS_GRAPHIFY_COMMANDS]);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(systemPrompt).toContain('graphify commands section');
    expect(systemPrompt).not.toContain('CodebaseGraph tool section');
    expect(graphifyOut).toBe('/project/.workbench/knowledge/graphify-out');
  });

  it('shows the command of a Bash graph search', async () => {
    setRun([
      blockStart(0, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"command": "graphify explain AgentManager", ' }),
      delta(0, { type: 'input_json_delta', partial_json: '"description": "Explain AgentManager"}' }),
      blockStop(0),
      ...conversation,
    ]);
    const { promise, events } = await run();
    const result = await promise;
    expect(result.toolCalls[0]).toEqual({ name: 'Bash', input: 'graphify explain AgentManager' });
    expect(events[0]).toEqual({ type: 'tool-start', name: 'Bash', input: 'graphify explain AgentManager' });
  });

  it("gives the CLI Workbench's task tools as its only MCP server", async () => {
    setRun(conversation);
    const mcpServer = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer secret' } };
    await (await run({ taskTools: mcpServer })).promise;
    const { args, mcpConfig, mcpToolTimeout, systemPrompt } = record();

    expect(mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    // The token stays in the config file, out of the process arguments
    expect(args.join(' ')).not.toContain('secret');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain(INSIGHTS_TASK_TOOLS_RULE);
    expect(args[args.indexOf('--tools') + 1]).toBe([...INSIGHTS_READ_ONLY_TOOLS, ...INSIGHTS_WEB_TOOLS].join(','));
    expect(Number(mcpToolTimeout)).toBeGreaterThan(10 * 60 * 1000);
    expect(systemPrompt).toContain('mcp__workbench__');
    expect(systemPrompt).toContain('__TASK_SUGGESTION__');
  });

  it('lets Claude message other running sessions with the task tools when sessions may message tasks', async () => {
    setRun(conversation);
    const taskTools = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp' };
    await (await run({ taskTools, sessionMessages: true, taskMessaging: true })).promise;
    const { args, systemPrompt } = record();

    expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(expect.arrayContaining([...INSIGHTS_SESSION_MESSAGING_TOOLS]));
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(expect.arrayContaining([...INSIGHTS_SESSION_MESSAGING_TOOLS]));
    expect(systemPrompt).toContain('use SendMessage with a name from ListAgents');
    expect(systemPrompt).toContain('use message_task');
  });

  it('offers message_task only while Task messaging is on', async () => {
    const taskTools = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp' };
    setRun(conversation);
    await (await run({ taskTools, taskMessaging: false })).promise;
    expect(record().systemPrompt).not.toContain('use message_task');
    expect(record().systemPrompt).toContain('Task messaging is off');
    setRun(conversation);
    await (await run({ taskTools, taskMessaging: true })).promise;
    expect(record().systemPrompt).toContain('use message_task: a running task reads it at its next step');
  });

  it('keeps ListAgents and SendMessage out with session messages off, and gives them without the task tools', async () => {
    const taskTools = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp' };
    setRun(conversation);
    await (await run({ taskTools, sessionMessages: false })).promise;
    const off = record();
    for (const tool of INSIGHTS_SESSION_MESSAGING_TOOLS) expect(off.args).not.toContain(tool);
    expect(off.args[off.args.indexOf('--tools') + 1]).not.toContain('SendMessage');
    expect(off.systemPrompt).not.toContain('ListAgents');

    setRun(conversation);
    await (await run({ sessionMessages: true })).promise;
    const on = record();
    expect(on.args[on.args.indexOf('--tools') + 1].split(',')).toEqual(expect.arrayContaining([...INSIGHTS_SESSION_MESSAGING_TOOLS]));
  });

  it('tells a chat with the messaging tools its name and how to reach the other chats and windows', async () => {
    const taskTools = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp' };
    setRun(conversation);
    await (await run({ taskTools, kanbanTools: false, chatName: 'chat-abc123', sessionMessages: true })).promise;
    const { args, systemPrompt } = record();
    expect(systemPrompt).toContain('This chat is named chat-abc123');
    expect(systemPrompt).toContain('message_chat');
    expect(systemPrompt).toContain('sendMessageTo');
    expect(systemPrompt).toContain('[Message from');
    // The Workbench tools hold only the messaging tools: no Kanban section
    expect(systemPrompt).not.toContain('Workbench task tools');
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain(INSIGHTS_TASK_TOOLS_RULE);
  });

  it("gives the CLI the chat's MCP servers next to the task tools", async () => {
    setRun(conversation);
    const taskTools = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp' };
    const context7 = { type: 'stdio' as const, command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
    await (await run({ taskTools, mcpServers: { context7, workbench: context7 } })).promise;
    const { args, mcpConfig } = record();

    // A chat server can't replace the task tools
    expect(mcpConfig).toEqual({ mcpServers: { context7, workbench: taskTools } });
    const allowed = args.slice(args.indexOf('--allowedTools') + 1);
    expect(allowed).toContain('mcp__context7');
    expect(allowed).toContain(INSIGHTS_TASK_TOOLS_RULE);
  });

  it("runs the chat's Playwright through the guard, in the turn's own folder, which the chat may read", async () => {
    setRun(conversation);
    const playwright = { type: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chromium', '--isolated', '--sandbox'] };
    await (await run({ mcpServers: { playwright } })).promise;
    const { args, mcpConfig } = record();

    const guarded = mcpConfig.mcpServers.playwright;
    const [script, dir, ...server] = guarded.args as string[];
    expect(guarded).toMatchObject({ type: 'stdio', command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(script).toMatch(/playwright-guard\.cjs$/);
    expect(dir).toMatch(/workbench-insights-[^/\\]+[/\\]playwright$/);
    // The server's own files go to that folder too, linked with paths the chat can read
    expect(server).toEqual([...['npx', ...playwright.args], '--output-dir', dir, '--file-paths', 'absolute']);
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', dir]);
    expect((args as string[]).filter((arg) => arg === '--add-dir')).toHaveLength(1);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__playwright__browser_run_code_unsafe');
  });

  it("gives the CLI the chat's MCP servers without the task tools", async () => {
    setRun(conversation);
    const context7 = { type: 'stdio' as const, command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
    await (await run({ mcpServers: { context7 } })).promise;
    const { args, mcpConfig, mcpToolTimeout, mcpTimeout } = record();

    expect(mcpConfig).toEqual({ mcpServers: { context7 } });
    // Time for the server's first start, when npx downloads it
    expect(Number(mcpTimeout)).toBeGreaterThan(60 * 1000);
    expect(args).toContain('mcp__context7');
    expect(args).not.toContain(INSIGHTS_TASK_TOOLS_RULE);
    expect(mcpToolTimeout).toBeNull();
    // No Playwright: nothing else to read, nothing to leave out
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--disallowedTools');
  });

  it("lets Claude use gh's and glab's read-only commands, and no other command, when their buttons are on", async () => {
    setRun(conversation);
    await (await run({ cliTools: { github: true, gitlab: true } })).promise;
    const { args, systemPrompt } = record();

    expect(args[args.indexOf('--tools') + 1]).toContain('Bash');
    const allowed: string[] = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'));
    expect(allowed).toEqual(expect.arrayContaining([...INSIGHTS_GITHUB_RULES, ...INSIGHTS_GITLAB_RULES]));
    expect(allowed).toContain('Bash(gh pr view:*)');
    expect(allowed).toContain('Bash(glab mr view:*)');
    // No wildcard over the whole CLI, nor commands that change files, git state or the remote
    expect(allowed).not.toContain('Bash(gh:*)');
    expect(allowed).not.toContain('Bash(glab:*)');
    const bashRules = allowed.filter((rule) => rule.startsWith('Bash('));
    for (const command of ['gh pr checkout', 'gh repo sync', 'gh run download', 'gh release download', 'gh api', 'gh alias', 'gh extension', 'gh pr create', 'gh pr merge', 'gh issue comment', 'glab mr checkout', 'glab api', 'glab ci status', 'glab ci view', 'glab mr merge']) {
      expect(bashRules.some((rule) => command.startsWith(rule.slice('Bash('.length, -':*)'.length)))).toBe(false);
    }
    expect(allowed.some((rule) => rule.startsWith('Bash(graphify'))).toBe(false);
    expect(systemPrompt).toContain('GitHub CLI (`gh`)');
    expect(systemPrompt).toContain('GitLab CLI (`glab`)');
    expect(systemPrompt).toContain('`gh pr view`');
    expect(systemPrompt).toContain('`glab mr view`');
  });

  it('offers only gh with just the GitHub button on', async () => {
    setRun(conversation);
    await (await run({ cliTools: { github: true } })).promise;
    const { args, systemPrompt } = record();

    expect(args).toEqual(expect.arrayContaining(INSIGHTS_GITHUB_RULES));
    for (const rule of INSIGHTS_GITLAB_RULES) expect(args).not.toContain(rule);
    expect(systemPrompt).not.toContain('glab');
  });

  it('takes a local slash command\'s output as the reply and keeps its session (no assistant message)', async () => {
    setRun([
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] },
      { type: 'system', subtype: 'compact_boundary', session_id: 'sess-1', uuid: 'boundary-1' },
      { type: 'user', uuid: 'stdout-1', message: { content: '<local-command-stdout>Compacted </local-command-stdout>' } },
      { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'sess-1' },
    ]);
    const result = await (await run({ message: '/compact' })).promise;
    expect(result.text).toBe('Compacted');
    expect(result.claudeRef).toEqual({ sessionId: 'sess-1', messageUuid: 'stdout-1', profileId: 'main' });
  });

  it('accepts a slash command that printed nothing; other empty replies are still an error', async () => {
    const quiet = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] },
      { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'sess-1' },
    ];
    setRun(quiet);
    await expect((await run({ message: '/reload-plugins' })).promise).resolves.toMatchObject({ text: '' });
    setRun(quiet);
    await expect((await run()).promise).rejects.toThrow('empty response');
  });

  it('gives a turn with the Clawd button what an agent window has: every tool, the user\'s MCP servers, auto mode', async () => {
    setRun(conversation);
    await (await run({ agentMode: { skipPermissions: false }, cliTools: { github: true } })).promise;
    const { args, systemPrompt } = record();
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(systemPrompt).toContain("Claude Code's full tool set");
    // No read-only command list: Bash isn't limited
    expect(systemPrompt).not.toContain('Only these commands are allowed');
  });

  it('skips permissions in a Clawd turn when agent windows skip them', async () => {
    setRun(conversation);
    await (await run({ agentMode: { skipPermissions: true } })).promise;
    const { args } = record();
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('resumes the same session read-only once the Clawd button is off again', async () => {
    setRun(conversation);
    await (await run({ session: { mode: 'resume', sessionId: 'chat-session', profileId: 'main' } })).promise;
    const { args, systemPrompt } = record();
    expect(args[args.indexOf('--resume') + 1]).toBe('chat-session');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--tools');
    expect(systemPrompt).not.toContain("Claude Code's full tool set");
  });

  it('lets Claude write only its project memory when self-improve is on', async () => {
    setRun(conversation);
    await (await run({ memory: true })).promise;
    const { args, systemPrompt } = record();
    const tools = args[args.indexOf('--tools') + 1].split(',');
    expect(tools).toEqual(expect.arrayContaining(['Write', 'Edit']));
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain(INSIGHTS_MEMORY_RULE);
    expect(INSIGHTS_MEMORY_RULE).toBe('Edit(.workbench/compeng/**)');
    expect(systemPrompt).toContain('## Project memory');
  });

  it('takes suggestion lines out of the reply and returns each one', async () => {
    setRun([
      conversation[0],
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two ideas.\n__TASK_SUGGESTION__:{"title": "A", "description": "Do A"}\n__TASK_SUGGESTION__:{"title": "B", "description": "Do B"}' } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'x' },
    ]);
    const result = await (await run()).promise;
    expect(result.text).toBe('Two ideas.');
    expect(result.taskSuggestions).toEqual([{ title: 'A', description: 'Do A' }, { title: 'B', description: 'Do B' }]);
  });

  describe('Claude Code sessions', () => {
    const withIds = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] },
      { type: 'assistant', uuid: 'msg-a', session_id: 'sess-1', message: { content: [] } },
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Done.' }),
      blockStop(0),
      { type: 'assistant', uuid: 'msg-b', session_id: 'sess-1', message: { content: [] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-1' },
    ];
    const history = [{ role: 'user' as const, content: 'Earlier question' }, { role: 'assistant' as const, content: 'Earlier answer' }];

    it('starts a named session with the conversation folded in, and says where the reply ends', async () => {
      setRun(withIds);
      const result = await (await run({ history, title: 'Auth' })).promise;
      const { args, stdin } = record();
      expect(args[args.indexOf('--name') + 1]).toBe('Workbench chat: Auth');
      expect(stdin).toContain('Earlier answer');
      expect(result.claudeRef).toEqual({ sessionId: 'sess-1', messageUuid: 'msg-b', profileId: 'main' });
    });

    it('resumes the session with the new message only', async () => {
      setRun(withIds);
      await (await run({ history, session: { mode: 'resume', sessionId: 'sess-1', profileId: 'main' } })).promise;
      const { args, stdin } = record();
      expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
      expect(args).not.toContain('--fork-session');
      expect(args).not.toContain('--session-id');
      expect(stdin).not.toContain('Earlier answer');
      expect(stdin).toContain('How does auth work?');
    });

    it('forks the session at an earlier reply, leaving the original as it was', async () => {
      setRun(withIds);
      await (await run({ history, session: { mode: 'fork', sessionId: 'sess-1', atMessageUuid: 'msg-a', profileId: 'main' } })).promise;
      const { args, stdin } = record();
      expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual([
        '--resume', 'sess-1', '--resume-session-at', 'msg-a', '--fork-session',
      ]);
      expect(stdin).not.toContain('Earlier answer');
    });

    it("gives a resumed session only this turn's tools and MCP servers", async () => {
      setRun(withIds);
      await (await run({ session: { mode: 'resume', sessionId: 'sess-1', profileId: 'main' } })).promise;
      const { args, mcpConfig } = record();
      expect(args[args.indexOf('--tools') + 1]).toBe([...INSIGHTS_READ_ONLY_TOOLS, ...INSIGHTS_WEB_TOOLS].join(','));
      expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'))).toEqual([...INSIGHTS_WEB_TOOLS]);
      expect(args).toContain('--strict-mcp-config');
      expect(mcpConfig).toBeNull();
    });

    it('starts a new session when the session belongs to another account', async () => {
      setRun(withIds);
      await (await run({ history, session: { mode: 'resume', sessionId: 'sess-1', profileId: 'other' } })).promise;
      const { args, stdin } = record();
      expect(args).not.toContain('--resume');
      expect(stdin).toContain('Earlier answer');
    });

    it('sends the turn\'s own system prompt to new, resumed and forked sessions, not a recorded one', async () => {
      const sessions = [
        { mode: 'new' },
        { mode: 'resume', sessionId: 'sess-1', profileId: 'main' },
        { mode: 'fork', sessionId: 'sess-1', atMessageUuid: 'msg-a', profileId: 'main' },
      ];
      for (const session of sessions) {
        setRun(withIds);
        await (await run({ session })).promise;
        const { args } = record();
        expect(args[args.indexOf('--system-prompt-snapshot') + 1]).toBe('off');
        expect(args).toContain('--append-system-prompt-file');
      }
    });

    it('leaves --system-prompt-snapshot out for Claude Code versions without it', async () => {
      for (const version of ['2.1.266', undefined]) {
        cliVersion = version;
        setRun(withIds);
        await (await run({ session: { mode: 'resume', sessionId: 'sess-1', profileId: 'main' } })).promise;
        expect(record().args).not.toContain('--system-prompt-snapshot');
      }
    });

    it('starts a new session when the session can no longer be resumed', async () => {
      setRun(withIds);
      process.env.FAKE_RESUME_FAILS = '1';
      const result = await (await run({ history, session: { mode: 'resume', sessionId: 'gone', profileId: 'main' } })).promise;
      const [first, second] = runs();
      expect(first).toContain('--resume');
      expect(second).not.toContain('--resume');
      expect(second).toContain('--session-id');
      expect(record().stdin).toContain('Earlier answer');
      expect(result.text).toBe('Done.');
    });
  });

  it('keeps Bash out without a memory graph', async () => {
    setRun(conversation);
    await (await run()).promise;
    const { args, graphifyOut } = record();
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'))).toEqual([...INSIGHTS_WEB_TOOLS]);
    expect(args[args.indexOf('--tools') + 1]).not.toContain('Bash');
    expect(graphifyOut).toBeNull();
  });

  it('sends history, the question and attachments as one stream-json user message', async () => {
    setRun(conversation);
    await (await run({
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      attachments: [
        { id: '1', filename: 'shot.png', mimeType: 'image/png', size: 4, data: 'iVBORw==' },
        { id: '2', filename: 'notes.md', mimeType: 'text/markdown', size: 5, data: Buffer.from('# Hi').toString('base64') },
      ],
    })).promise;

    const message = JSON.parse(record().stdin);
    expect(message.type).toBe('user');
    expect(message.message.content[0].text).toContain('Previous conversation:');
    expect(message.message.content[0].text).toContain('Current question: How does auth work?');
    expect(message.message.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    expect(message.message.content[2].text).toContain('<attached_file name="notes.md">');
  });

  it('rejects with the CLI error result (e.g. usage limit) and reports it', async () => {
    setRun([{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }]);
    const { promise, events } = await run();
    await expect(promise).rejects.toThrow('Claude AI usage limit reached');
    expect(events).toContainEqual({ type: 'error', error: 'Claude AI usage limit reached' });
  });

  it('rejects with stderr when the CLI exits without a result', async () => {
    setRun([], 1, 'Invalid API key · Please run /login');
    await expect((await run()).promise).rejects.toThrow('Invalid API key · Please run /login');
  });

  it('rejects when the CLI produced no answer', async () => {
    setRun([{ type: 'result', subtype: 'success', is_error: false, result: '' }]);
    await expect((await run()).promise).rejects.toThrow(/empty response/i);
  });

  it('reports a missing Claude Code CLI with an error code', async () => {
    cliFound = false;
    const { promise } = await run();
    const error = await promise.catch((e: Error) => e);
    expect(parseInsightsError((error as Error).message).code).toBe(INSIGHTS_ERROR_CODES.claudeCodeMissing);
  });

  describe('with Claude Code in WSL', () => {
    const mcpServer = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer secret' } };

    it("reaches the task tools through the stdio bridge under NAT networking, where the app's 127.0.0.1 is out of reach", async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig, systemPrompt, bridgeSource } = record();
      const server = mcpConfig.mcpServers.workbench;
      // Workbench's own executable by its Linux path, the script by its Windows path
      expect(server).toEqual({
        type: 'stdio',
        command: `/runtime${process.execPath.replace(/\\/g, '/')}`,
        args: [expect.stringMatching(/task-tools-bridge.cjs$/)],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          WORKBENCH_TASK_TOOLS_URL: 'http://127.0.0.1:4567/mcp',
          WORKBENCH_TASK_TOOLS_TOKEN: 'secret',
          WSLENV: 'ELECTRON_RUN_AS_NODE:WORKBENCH_TASK_TOOLS_URL:WORKBENCH_TASK_TOOLS_TOKEN',
        },
      });
      expect(server.args[0].startsWith('/runtime')).toBe(false);
      // The script exists while the turn runs
      expect(bridgeSource).toContain('WORKBENCH_TASK_TOOLS_TOKEN');
      expect(JSON.stringify(args)).not.toContain('secret');
      expect(args).toContain(INSIGHTS_TASK_TOOLS_RULE);
      expect(systemPrompt).toContain('mcp__workbench__');
    });

    it.each(['nat', 'mirrored'])('turns the task tools off after the bridge failed to start (%s networking)', async (networkingMode) => {
      wslRef.info = { distro: 'Ubuntu', networkingMode, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun([{ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'workbench', status: 'failed' }] }, ...conversation.slice(1)]);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig.mcpServers.workbench.type).toBe('stdio');

      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig, systemPrompt } = record();
      expect(mcpConfig).toBeNull();
      expect(args).not.toContain(INSIGHTS_TASK_TOOLS_RULE);
      expect(systemPrompt).not.toContain('mcp__workbench__');
    });

    it('offers no task tools from the first turn when the distribution has WSL interop off', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', interop: false, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig } = record();
      expect(mcpConfig).toBeNull();
      expect(args).not.toContain(INSIGHTS_TASK_TOOLS_RULE);
    });

    it('keeps the direct HTTP entry in WSL1, which shares the host network', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: null, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      wslRef.version = 1;
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    });

    it("checks the distribution's claude version for --system-prompt-snapshot", async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', tools: { claude: { path: '/home/me/.local/bin/claude', version: '2.1.267' } } };
      cliVersion = undefined;
      setRun(conversation);
      await (await run()).promise;
      expect(record().args).toContain('--system-prompt-snapshot');

      wslRef.info.tools.claude.version = '2.0.0';
      setRun(conversation);
      await (await run()).promise;
      expect(record().args).not.toContain('--system-prompt-snapshot');
    });

    it('keeps the task tools directly with mirrored networking when interop is off', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', interop: false, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    });

    it('uses the bridge with mirrored networking too (the Hyper-V firewall blocks the distribution)', () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', interop: true, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      expect(getTaskToolsRoute()).toBe('bridge');
    });

    it("gives the chat browser's guard the Windows relay under NAT networking, and the relay with mirrored networking too", async () => {
      const playwright = {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.83', '--endpoint', 'Workbench chat c1'],
        env: { WORKBENCH_CHAT_BROWSER_URL: 'http://127.0.0.1:4567/mcp', WORKBENCH_CHAT_BROWSER_TOKEN: 'secret' },
      };
      const turnDir = mkdtempSync(join(tmpdir(), 'guard-relay-test-'));
      try {
        wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
        const nat = (await guardChatPlaywright({ playwright }, turnDir)).servers.playwright as { command: string; env: Record<string, string> };
        // Run by the distribution's node; the relay is Workbench's executable (its Linux path) with a Windows-side script
        expect(nat.command).toBe('node');
        const relay = JSON.parse(nat.env[CHAT_BROWSER_RELAY_ENV]);
        expect(relay.command).toBe(`/runtime${process.execPath.replace(/\\/g, '/')}`);
        expect(relay.script).toBe(join(turnDir, 'task-tools-bridge.cjs'));
        expect(readFileSync(relay.script, 'utf-8')).toContain('WORKBENCH_TASK_TOOLS_TOKEN');
        expect(nat.env.WORKBENCH_CHAT_BROWSER_TOKEN).toBe('secret');

        wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
        const mirrored = (await guardChatPlaywright({ playwright }, turnDir)).servers.playwright as { env: Record<string, string> };
        expect(JSON.parse(mirrored.env[CHAT_BROWSER_RELAY_ENV]).script).toBe(join(turnDir, 'task-tools-bridge.cjs'));
        wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', interop: false, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
        const direct = (await guardChatPlaywright({ playwright }, turnDir)).servers.playwright as { env: Record<string, string> };
        expect(direct.env[CHAT_BROWSER_RELAY_ENV]).toBeUndefined();
        expect(direct.env.WORKBENCH_CHAT_BROWSER_URL).toBe('http://127.0.0.1:4567/mcp');
        expect(mirrored.env.WORKBENCH_CHAT_BROWSER_URL).toBe('http://127.0.0.1:4567/mcp');
      } finally {
        rmSync(turnDir, { recursive: true, force: true });
      }
    });

    it("runs the guard and its server on Windows when the chat's browser runs there, its paths translated for WSL", async () => {
      const playwright = {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.83', '--endpoint', 'Workbench chat c1'],
        env: { WORKBENCH_CHAT_BROWSER_URL: 'http://127.0.0.1:4567/mcp', WORKBENCH_CHAT_BROWSER_TOKEN: 'secret' },
      };
      const turnDir = mkdtempSync(join(tmpdir(), 'guard-windows-test-'));
      try {
        wslRef.info = { distro: 'Ubuntu', mountRoot: '/mnt/', networkingMode: 'nat', tools: { claude: { path: '/home/me/.local/bin/claude' } } } as typeof wslRef.info;
        windowsRef.node = { node: 'C:\\Program Files\\nodejs\\node.exe', npx: 'C:\\Program Files\\nodejs\\npx.cmd', version: 'v22.0.0' };
        const result = await guardChatPlaywright({ playwright }, turnDir);
        const guarded = result.servers.playwright as { command: string; args: string[]; env: Record<string, string> };
        const dir = join(turnDir, 'playwright');
        // Workbench's executable as Node, started through interop; the guard and folders by their Windows paths
        expect(guarded.command).toBe(`/runtime${process.execPath.replace(/\\/g, '/')}`);
        expect(guarded.args).toEqual([
          join(turnDir, 'playwright-guard.cjs'), dir, windowsRef.node.npx,
          '-y', '@playwright/mcp@0.0.83', '--endpoint', 'Workbench chat c1', '--output-dir', dir, '--file-paths', 'absolute',
        ]);
        expect(guarded.env).toMatchObject({
          ELECTRON_RUN_AS_NODE: '1',
          WORKBENCH_CHAT_BROWSER_URL: 'http://127.0.0.1:4567/mcp',
          WORKBENCH_CHAT_BROWSER_TOKEN: 'secret',
          WSLENV: 'ELECTRON_RUN_AS_NODE:WORKBENCH_CHAT_BROWSER_URL:WORKBENCH_CHAT_BROWSER_TOKEN:WORKBENCH_PATH_MAP',
        });
        // Reaches Workbench directly: no relay
        expect(guarded.env[CHAT_BROWSER_RELAY_ENV]).toBeUndefined();
        expect(JSON.parse(guarded.env.WORKBENCH_PATH_MAP)).toEqual({ from: dir, to: `/runtime${dir.replace(/\\/g, '/')}`, distro: 'Ubuntu', mountRoot: '/mnt/' });
        expect(result.dir).toBe(dir);

        // A server that isn't the chat browser's (no chat browser URL) runs in WSL as before
        const own = (await guardChatPlaywright({ playwright: { ...playwright, env: {} } }, turnDir)).servers.playwright as { command: string };
        expect(own.command).toBe('node');
      } finally {
        windowsRef.node = null;
        rmSync(turnDir, { recursive: true, force: true });
      }
    });

    it("reports a missing Claude Code CLI when the distribution has none", async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: null } } };
      const { promise } = await run();
      const error = await promise.catch((e: Error) => e);
      expect(parseInsightsError((error as Error).message).code).toBe(INSIGHTS_ERROR_CODES.claudeCodeMissing);
    });
  });
});

describe('supportsSystemPromptSnapshot', () => {
  it('is true from Claude Code 2.1.267, whatever the version text around the number', () => {
    expect(supportsSystemPromptSnapshot('2.1.267')).toBe(true);
    expect(supportsSystemPromptSnapshot('2.1.312 (Claude Code)')).toBe(true);
    expect(supportsSystemPromptSnapshot('2.2.0')).toBe(true);
    expect(supportsSystemPromptSnapshot('2.1.266')).toBe(false);
    expect(supportsSystemPromptSnapshot('1.0.128')).toBe(false);
    expect(supportsSystemPromptSnapshot(undefined)).toBe(false);
    expect(supportsSystemPromptSnapshot('unknown')).toBe(false);
  });
});

describe('toClaudeModel', () => {
  it('keeps aliases and full Claude IDs, maps legacy IDs to their family, defaults to sonnet', () => {
    expect(toClaudeModel('opus')).toBe('opus');
    expect(toClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(toClaudeModel('us.anthropic.haiku-x')).toBe('haiku');
    expect(toClaudeModel('gpt-5')).toBe('sonnet');
    expect(toClaudeModel(undefined)).toBe('sonnet');
  });
});
