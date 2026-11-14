/**
 * Messages from the project's other chats and agent windows: shown in the chat with their sender,
 * framed for Claude as another session's, answered by the chat's own reply (after the reply it is
 * writing), and refused for a chat that is gone. And an agent window's session opened as a chat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = vi.fn();
const replying = new Set<string>();

vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  class FakeExecutor extends EventEmitter {
    cancelSession() { return false; }
    isSessionActive(_projectId: string, chatId?: string) { return !!chatId && replying.has(chatId); }
    async execute(...args: unknown[]) {
      const turn = args[6] as { beforeRun?: () => Promise<unknown>; prepare?: () => Promise<void>; chatSessionId?: string } | undefined;
      await turn?.beforeRun?.();
      // As the real executor: a failed prepare ends the turn with its error
      try {
        await turn?.prepare?.();
      } catch (error) {
        this.emit('error', args[0], (error as Error).message, turn?.chatSessionId);
        throw error;
      }
      return execute(...args);
    }
  }
  return { InsightsExecutor: FakeExecutor };
});
vi.mock('../insights/config', () => ({ InsightsConfig: class { configure() {} } }));
const ensureWindow = vi.fn(async () => true);
vi.mock('../session-messaging/agent-windows', () => ({ ensureAgentWindowRunning: (...args: unknown[]) => ensureWindow(...(args as [])) }));
/** An agent window running a chat's session too (shared-session.ts), and the session's transcript */
const shared = vi.hoisted(() => ({
  window: undefined as { terminal: { id: string }; busy: boolean; atShell: boolean; shellIdle: boolean } | undefined,
  transcript: null as string | null,
  held: [] as string[],
  released: 0,
}));
vi.mock('../session-messaging/shared-session', () => ({
  sessionWindow: async () => shared.window,
  shareSessionForReply: (_projectPath: string, _found: unknown, sessionId: string) => {
    shared.held.push(sessionId);
    return async () => {
      shared.released++;
    };
  },
}));
vi.mock('../terminal/session-follower', () => ({ findTranscript: async () => shared.transcript }));

import { insightsService as service, planClaudeSession } from '../insights-service';
import { getChatSource } from '../session-messaging/directory';

let projectDir: string;
let pid: string;
let run = 0;
const from = { kind: 'agent' as const, name: 'agent-1a2b3c4d', title: 'Agent 1' };

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'insights-messages-'));
  pid = `project-${++run}`;
  execute.mockReset();
  replying.clear();
  shared.window = undefined;
  shared.transcript = null;
  shared.held = [];
  shared.released = 0;
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function chatWithOneReply(): Promise<string> {
  execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [] });
  await service.sendMessage(pid, projectDir, 'hi');
  return service.loadSession(pid, projectDir)!.id;
}

describe('messages to a chat', () => {
  it('registers the chat as where messages to chats go', () => {
    expect(getChatSource()).not.toBeNull();
  });

  it('shows the message with its sender and replies to it, telling Claude it is from another session', async () => {
    const chatId = await chatWithOneReply();
    execute.mockResolvedValueOnce({ fullResponse: 'Got it', toolsUsed: [] });

    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'The build is green')).resolves.toEqual({ status: 'started' });
    await flush();

    const session = service.loadSession(pid, projectDir)!;
    expect(session.messages.map((m) => [m.role, m.content, m.from?.name])).toEqual([
      ['user', 'hi', undefined],
      ['assistant', 'Hello', undefined],
      ['user', 'The build is green', 'agent-1a2b3c4d'],
      ['assistant', 'Got it', undefined],
    ]);
    const [, , message] = execute.mock.calls.at(-1)!;
    expect(message).toContain('[Message from the agent window "Agent 1" (agent-1a2b3c4d)');
    expect(message).toContain('not from the user');
    expect(message.endsWith('The build is green')).toBe(true);
  });

  it('waits for the reply the chat is writing, then answers', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'later')).resolves.toEqual({ status: 'queued' });
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);

    // The reply ends: the message is answered after it
    replying.delete(chatId);
    execute.mockResolvedValueOnce({ fullResponse: 'Reply to the user', toolsUsed: [] });
    execute.mockResolvedValueOnce({ fullResponse: 'Reply to the window', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'user question');
    await flush();
    await flush();

    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual([
      'hi', 'Hello', 'user question', 'Reply to the user', 'later', 'Reply to the window',
    ]);
  });

  it('keeps where the user sent a message, and tells Claude to deliver it there', async () => {
    execute.mockResolvedValueOnce({ fullResponse: 'Sent it', toolsUsed: [] });
    const to = { kind: 'agent' as const, name: 'agent-1a2b3c4d', title: 'Agent 1' };
    await service.sendMessage(pid, projectDir, 'The build is green', undefined, undefined, to);
    const session = service.loadSession(pid, projectDir)!;
    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'The build is green', to });
    const [, , message] = execute.mock.calls.at(-1)!;
    expect(message).toContain('[The user sends this to the agent window "Agent 1" (agent-1a2b3c4d)');
    expect(message).toContain('SendMessage');
    expect(message.endsWith('The build is green')).toBe(true);
  });

  it('opens the agent window a message goes to before the reply, again on a regenerate', async () => {
    ensureWindow.mockClear();
    const to = { kind: 'agent' as const, name: 'agent-1a2b3c4d', title: 'Agent 1' };
    execute.mockResolvedValueOnce({ fullResponse: 'Sent it', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'say hello', undefined, undefined, to);
    expect(ensureWindow).toHaveBeenLastCalledWith(projectDir, 'agent-1a2b3c4d');

    ensureWindow.mockClear();
    execute.mockResolvedValueOnce({ fullResponse: 'Sent it again', toolsUsed: [] });
    await service.regenerate(pid, projectDir);
    expect(ensureWindow).toHaveBeenCalledWith(projectDir, 'agent-1a2b3c4d');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('answers at most five messages from other sessions in a row, then waits for the user', async () => {
    const chatId = await chatWithOneReply();
    for (let n = 1; n <= 5; n++) {
      execute.mockResolvedValueOnce({ fullResponse: `answer ${n}`, toolsUsed: [] });
      await expect(service.receiveMessage(pid, projectDir, chatId, from, `ping ${n}`)).resolves.toEqual({ status: 'started' });
      await flush();
    }
    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'ping 6')).resolves.toEqual({ status: 'held', answered: 5 });
    await flush();
    const messages = service.loadSession(pid, projectDir)!.messages;
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'ping 6' });
    expect(execute).toHaveBeenCalledTimes(6);

    // The user writes: it answers again
    execute.mockResolvedValueOnce({ fullResponse: 'to the user', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'carry on');
    execute.mockResolvedValueOnce({ fullResponse: 'answer 7', toolsUsed: [] });
    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'ping 7')).resolves.toEqual({ status: 'started' });
  });

  it('keeps the limit for messages that waited for a reply', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    for (let n = 1; n <= 7; n++) {
      await expect(service.receiveMessage(pid, projectDir, chatId, from, `burst ${n}`)).resolves.toEqual({ status: 'queued' });
    }
    replying.delete(chatId);
    // A reply that ends: the waiting ones are answered one after another, five at most
    execute.mockResolvedValueOnce({ fullResponse: 'to the user', toolsUsed: [] });
    for (let n = 1; n <= 5; n++) execute.mockResolvedValueOnce({ fullResponse: `answer ${n}`, toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'again');
    for (let n = 0; n < 20; n++) await flush();
    expect(execute).toHaveBeenCalledTimes(2 + 5);
    const contents = service.loadSession(pid, projectDir)!.messages.map((m) => m.content);
    // The last two are shown without a reply
    expect(contents.slice(-2)).toEqual(['burst 6', 'burst 7']);
  });

  it('shows the messages that waited without answering them after a stop, and passes them on with the next message', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    await service.receiveMessage(pid, projectDir, chatId, from, 'burst 1');
    await service.receiveMessage(pid, projectDir, chatId, from, 'burst 2');
    replying.delete(chatId);
    // A reply the user stops: the waiting messages show, and nothing starts
    execute.mockResolvedValueOnce({ fullResponse: '', toolsUsed: [], stopped: true });
    await service.sendMessage(pid, projectDir, 'question');
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    let messages = service.loadSession(pid, projectDir)!.messages;
    expect(messages.slice(-2).map((m) => [m.role, m.content, m.from?.name])).toEqual([
      ['user', 'burst 1', 'agent-1a2b3c4d'],
      ['user', 'burst 2', 'agent-1a2b3c4d'],
    ]);

    // The user's next message resumes the session from the last finished reply and brings them
    execute.mockResolvedValueOnce({ fullResponse: 'All three', toolsUsed: [], claudeRef: { sessionId: 's', messageUuid: 'u2' } });
    await service.sendMessage(pid, projectDir, 'and now?');
    // (The stopped reply left no session to resume, so they come in the history of a new one)
    const [, , message, history, , , turn] = execute.mock.calls.at(-1)!;
    const seen = `${JSON.stringify(history)}\n${message}`;
    expect(seen).toContain('burst 1');
    expect(seen).toContain('burst 2');
    expect(message.endsWith('and now?')).toBe(true);
    messages = service.loadSession(pid, projectDir)!.messages;
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'All three' });
    expect(turn.chatSessionId).toBe(chatId);
  });

  it('answers other sessions read-only, even with the Clawd button on', async () => {
    execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'hi', { agentMode: true } as never);
    const chatId = service.loadSession(pid, projectDir)!.id;
    execute.mockResolvedValueOnce({ fullResponse: 'Got it', toolsUsed: [] });
    await service.receiveMessage(pid, projectDir, chatId, from, 'run this');
    await flush();
    const [, , , , config, , turn] = execute.mock.calls.at(-1)!;
    expect(config.agentMode).toBe(false);
    // It answers an agent window, so it may message one back
    expect(turn.reachesAgentWindow).toBe(true);
  });

  it('opens the agent window inside the turn, so a stop or a newer message sees the chat replying', async () => {
    const to = { kind: 'agent' as const, name: 'agent-1a2b3c4d', title: 'Agent 1' };
    execute.mockResolvedValueOnce({ fullResponse: 'Sent it', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'say hello', undefined, undefined, to);
    const [, , , , , , turn] = execute.mock.calls.at(-1)!;
    expect(typeof turn.beforeRun).toBe('function');
    expect(turn.reachesAgentWindow).toBe(true);
  });

  it('resumes the session past messages held without a reply, and passes them on', async () => {
    execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [], claudeRef: { sessionId: 's', messageUuid: 'r0' } });
    await service.sendMessage(pid, projectDir, 'hi');
    const chatId = service.loadSession(pid, projectDir)!.id;
    for (let n = 1; n <= 5; n++) {
      execute.mockResolvedValueOnce({ fullResponse: `answer ${n}`, toolsUsed: [], claudeRef: { sessionId: 's', messageUuid: `r${n}` } });
      await service.receiveMessage(pid, projectDir, chatId, from, `ping ${n}`);
      await flush();
    }
    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'ping 6')).resolves.toMatchObject({ status: 'held' });

    execute.mockResolvedValueOnce({ fullResponse: 'ok', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'what did it say?');
    const [, , message, , , , turn] = execute.mock.calls.at(-1)!;
    expect(turn.session).toEqual({ mode: 'resume', sessionId: 's', profileId: undefined });
    expect(message).toContain('ping 6');
    expect(message.endsWith('what did it say?')).toBe(true);
  });

  it('plans from the reply before the messages held from other sessions, not past one of the user\'s own', () => {
    const ref = { sessionId: 's', messageUuid: 'r1' };
    const message = (role: 'user' | 'assistant', extra = {}) => ({ id: role, role, content: role, timestamp: new Date(), ...extra });
    const chat = (messages: unknown[]) => ({ id: 'session-1', title: 't', createdAt: new Date(), updatedAt: new Date(), claudeHead: ref, messages });
    expect(planClaudeSession(chat([message('user'), message('assistant', { claudeRef: ref }), message('user', { from }), message('user')]) as never))
      .toEqual({ mode: 'resume', sessionId: 's', profileId: undefined });
    // A message of the user's own without a reply (its turn failed) may be in the session already
    expect(planClaudeSession(chat([message('user'), message('assistant', { claudeRef: ref }), message('user'), message('user')]) as never))
      .toEqual({ mode: 'new' });
  });

  it('holds a message while others wait for the user, instead of answering them unattended', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    await service.receiveMessage(pid, projectDir, chatId, from, 'burst 1');
    replying.delete(chatId);
    // A stopped reply: burst 1 is shown, waiting for the user
    execute.mockResolvedValueOnce({ fullResponse: '', toolsUsed: [], stopped: true });
    await service.sendMessage(pid, projectDir, 'question');
    await flush();
    const calls = execute.mock.calls.length;
    await expect(service.receiveMessage(pid, projectDir, chatId, from, 'burst 2')).resolves.toMatchObject({ status: 'held' });
    await flush();
    expect(execute).toHaveBeenCalledTimes(calls);
    expect(service.loadSession(pid, projectDir)!.messages.slice(-2).map((m) => m.content)).toEqual(['burst 1', 'burst 2']);
  });

  it('answers other sessions without the task tools or gh and glab, and may message an agent window back', async () => {
    execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'hi', { agentMode: true, kanbanTools: true, githubTools: true, gitlabTools: true } as never);
    const chatId = service.loadSession(pid, projectDir)!.id;
    execute.mockResolvedValueOnce({ fullResponse: 'Got it', toolsUsed: [] });
    await service.receiveMessage(pid, projectDir, chatId, from, 'merge PR 7');
    await flush();
    const [, , , , config, , turn] = execute.mock.calls.at(-1)!;
    expect(config).toMatchObject({ agentMode: false, kanbanTools: false, githubTools: false, gitlabTools: false });
    expect(turn.reachesAgentWindow).toBe(true);
  });

  it('gives a turn passing on held messages from an agent window the means to answer it', async () => {
    execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [], claudeRef: { sessionId: 's', messageUuid: 'r0' } });
    await service.sendMessage(pid, projectDir, 'hi');
    const chatId = service.loadSession(pid, projectDir)!.id;
    replying.add(chatId);
    await service.receiveMessage(pid, projectDir, chatId, from, 'from the window');
    replying.delete(chatId);
    execute.mockResolvedValueOnce({ fullResponse: '', toolsUsed: [], stopped: true });
    await service.regenerate(pid, projectDir);
    await flush();
    execute.mockResolvedValueOnce({ fullResponse: 'ok', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'what did it say?');
    const [, , message, history, , , turn] = execute.mock.calls.at(-1)!;
    expect(turn.reachesAgentWindow).toBe(true);
    // Passed on once: in the message, not also in the history
    expect(message).toContain('from the window');
    expect(JSON.stringify(history)).not.toContain('from the window');
  });

  it('keeps the messages that waited for a chat archived during its stopped reply', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    await service.receiveMessage(pid, projectDir, chatId, from, 'kept');
    replying.delete(chatId);
    service.archiveSession(pid, projectDir, chatId);
    execute.mockResolvedValueOnce({ fullResponse: '', toolsUsed: [], stopped: true });
    await service.regenerate(pid, projectDir, undefined, chatId);
    await flush();
    const archived = service.listSessions(projectDir, true).find((summary) => summary.id === chatId);
    expect(archived).toBeDefined();
    service.unarchiveSession(projectDir, chatId);
    expect(service.switchSession(pid, projectDir, chatId)!.messages.map((m) => m.content)).toContain('kept');
  });

  it('refuses a chat that is not there', async () => {
    await expect(service.receiveMessage(pid, projectDir, 'session-1', from, 'x')).resolves.toEqual({ status: 'notFound' });
  });
});

describe('an agent window opened as a chat', () => {
  const line = (value: Record<string, unknown>) => JSON.stringify(value);

  it('shows the window session\'s conversation and resumes it, again in the same chat later', async () => {
    const transcript = join(projectDir, 'session.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Fix the login bug' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/login.ts' } }] } }),
      line({ type: 'user', uuid: 't1', parentUuid: 'a1', message: { content: [{ type: 'tool_result', content: 'code' }] } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 't1', message: { content: [{ type: 'text', text: 'Fixed it.' }] } }),
    ].join('\n'));

    const chatId = await service.openSessionAsChat(pid, projectDir, { sessionId: 'win-session', transcriptPath: transcript, profileId: 'main' });
    const session = service.loadSession(pid, projectDir)!;
    expect(session.id).toBe(chatId);
    expect(session.title).toBe('Fix the login bug');
    expect(session.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Fix the login bug'],
      ['assistant', 'Looking.\n\nFixed it.'],
    ]);
    expect(session.messages[1].toolsUsed?.map((tool) => tool.name)).toEqual(['Read']);
    expect(session.claudeHead).toEqual({ sessionId: 'win-session', messageUuid: 'a2', profileId: 'main' });

    // Opened again later (archived meanwhile): the same chat, back in the history, with what
    // was said in the window since
    service.archiveSession(pid, projectDir, chatId!);
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Fix the login bug' } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Fixed it.' }] } }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'Now add a test' } }),
      line({ type: 'assistant', uuid: 'a3', parentUuid: 'u2', message: { content: [{ type: 'text', text: 'Added.' }] } }),
    ].join('\n'));
    await expect(service.openSessionAsChat(pid, projectDir, { sessionId: 'win-session', transcriptPath: transcript })).resolves.toBe(chatId);
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual([
      'Fix the login bug', 'Looking.\n\nFixed it.', 'Now add a test', 'Added.',
    ]);
    expect(service.loadSession(pid, projectDir)!.claudeHead?.messageUuid).toBe('a3');
    expect(service.listSessions(projectDir).map((summary) => summary.id)).toContain(chatId);
  });

  it('leaves out the summary a /compact writes and the note of an interrupted request', async () => {
    const transcript = join(projectDir, 'compacted.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Fix the bug' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      line({ type: 'user', uuid: 's1', parentUuid: 'a1', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } }),
      line({ type: 'user', uuid: 'u2', parentUuid: 's1', message: { content: 'Add a test' } }),
      line({ type: 'user', uuid: 'i1', parentUuid: 'u2', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    ].join('\n'));
    await service.openSessionAsChat(pid, projectDir, { sessionId: 'compacted', transcriptPath: transcript });
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['Fix the bug', 'Done.', 'Add a test']);
  });

  it('opens a new chat when the one opened before went on in another session, keeping what it said', async () => {
    const transcript = join(projectDir, 'diverged.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Question' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Answer' }] } }),
    ].join('\n'));
    const first = await service.openSessionAsChat(pid, projectDir, { sessionId: 'diverged', transcriptPath: transcript });
    // The chat goes on in a forked session (an edit)
    const chat = service.loadSession(pid, projectDir)!;
    chat.messages.push({ id: 'm-x', role: 'user', content: 'chat only', timestamp: new Date() });
    chat.claudeHead = { sessionId: 'forked', messageUuid: 'f1' };

    const second = await service.openSessionAsChat(pid, projectDir, { sessionId: 'diverged', transcriptPath: transcript });
    expect(second).not.toBe(first);
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['Question', 'Answer']);
  });

  it('reads past a /compact to the conversation before it', async () => {
    const transcript = join(projectDir, 'compacted.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Before compacting' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Earlier answer' }] } }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1' }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'b1', message: { content: 'After compacting' } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: [{ type: 'text', text: 'Later answer' }] } }),
    ].join('\n'));
    await service.openSessionAsChat(pid, projectDir, { sessionId: 'compacted', transcriptPath: transcript });
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual([
      'Before compacting', 'Earlier answer', 'After compacting', 'Later answer',
    ]);
  });

  it('follows the branch that leads to the last message (a rewind leaves the old one in the file)', async () => {
    const transcript = join(projectDir, 'branched.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'first try' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'abandoned' }] } }),
      line({ type: 'user', uuid: 'u2', parentUuid: null, message: { content: 'second try' } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: [{ type: 'text', text: 'kept' }] } }),
      line({ type: 'user', uuid: 'm1', parentUuid: 'a2', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', uuid: 'c1', parentUuid: 'a2', message: { content: '<command-name>/compact</command-name><command-args></command-args>' } }),
    ].join('\n'));
    await service.openSessionAsChat(pid, projectDir, { sessionId: 'branched', transcriptPath: transcript });
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['second try', 'kept', '/compact']);
  });

  it('opens nothing for a session without a conversation', async () => {
    const transcript = join(projectDir, 'empty.jsonl');
    writeFileSync(transcript, line({ type: 'summary', summary: 'x' }));
    await expect(service.openSessionAsChat(pid, projectDir, { sessionId: 'empty', transcriptPath: transcript })).resolves.toBeNull();
  });
});

describe('a chat sharing its session with an agent window', () => {
  const line = (value: Record<string, unknown>) => JSON.stringify(value);
  const ref = (messageUuid: string) => ({ sessionId: 'shared', messageUuid, profileId: 'main' });
  const idleWindow = () => ({ terminal: { id: 'abcdef12-0000-0000-0000-000000000000' }, busy: false, atShell: false, shellIdle: false });

  /** A chat with one reply in the session `shared` (its last point: a1) */
  async function chatInSharedSession(): Promise<string> {
    execute.mockResolvedValueOnce({ fullResponse: 'Hello', toolsUsed: [], claudeRef: ref('a1') });
    await service.sendMessage(pid, projectDir, 'hi');
    return service.loadSession(pid, projectDir)!.id;
  }

  /** The session's transcript */
  function transcript(lines: Array<Record<string, unknown>>): void {
    const file = join(projectDir, 'shared.jsonl');
    writeFileSync(file, lines.map(line).join('\n'));
    // A new time for each write (the sync reads a transcript that changed)
    const later = new Date(Date.now() + 60_000 + lines.length * 1000);
    utimesSync(file, later, later);
    shared.transcript = file;
  }

  const chatTurn = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: 'Hello' }] } },
  ];
  const windowTurn = [
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'typed in the window' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: [{ type: 'text', text: 'window reply' }] } },
  ];

  it("goes on from what was said in the window, resuming the session past it (no branch)", async () => {
    await chatInSharedSession();
    shared.window = idleWindow();
    transcript([...chatTurn, ...windowTurn]);
    execute.mockResolvedValueOnce({ fullResponse: 'Next reply', toolsUsed: [], claudeRef: ref('a3') });
    await service.sendMessage(pid, projectDir, 'next');

    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual([
      'hi', 'Hello', 'typed in the window', 'window reply', 'next', 'Next reply',
    ]);
    const turn = execute.mock.calls.at(-1)![6] as { session: unknown };
    expect(turn.session).toEqual({ mode: 'resume', sessionId: 'shared', profileId: 'main' });
    // The window was read-only during the reply, and given back after it
    expect(shared.held).toEqual(['shared']);
    expect(shared.released).toBe(1);
  });

  it('takes the window\'s turns in before messages held for the user, which are still passed on', async () => {
    await chatInSharedSession();
    const chat = service.loadSession(pid, projectDir)!;
    chat.messages.push({ id: 'held-1', role: 'user', content: 'held for you', timestamp: new Date(), from });
    shared.window = idleWindow();
    transcript([...chatTurn, ...windowTurn]);
    execute.mockResolvedValueOnce({ fullResponse: 'Next reply', toolsUsed: [], claudeRef: ref('a3') });
    await service.sendMessage(pid, projectDir, 'next');

    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual([
      'hi', 'Hello', 'typed in the window', 'window reply', 'held for you', 'next', 'Next reply',
    ]);
    const [, , message] = execute.mock.calls.at(-1)!;
    expect(message).toContain('held for you');
  });

  it('takes whole turns only: a turn the window is still writing comes in once it ends, once', async () => {
    const chatId = await chatInSharedSession();
    shared.window = idleWindow();
    transcript([...chatTurn, windowTurn[0]]);
    await expect(service.syncSharedSession(pid, projectDir, chatId)).resolves.toBe(false);
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);

    transcript([...chatTurn, ...windowTurn]);
    // Two looks at once take the turn in once
    const both = await Promise.all([service.syncSharedSession(pid, projectDir, chatId), service.syncSharedSession(pid, projectDir, chatId)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['hi', 'Hello', 'typed in the window', 'window reply']);
  });

  it("doesn't send while the window works in the session: the message is taken back", async () => {
    await chatInSharedSession();
    shared.window = { ...idleWindow(), busy: true };
    const errors: string[] = [];
    const onError = (_projectId: string, error: string) => errors.push(error);
    service.on('error', onError);
    await service.sendMessage(pid, projectDir, 'too early');
    service.off('error', onError);

    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['hi', 'Hello']);
    expect(errors).toEqual(['[agent_window_busy] agent-abcdef12']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("doesn't answer another session's message while the window works: it waits for the user", async () => {
    const chatId = await chatInSharedSession();
    shared.window = { ...idleWindow(), busy: true };
    await service.receiveMessage(pid, projectDir, chatId, from, 'from a window');
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.loadSession(pid, projectDir)!.messages.at(-1)).toMatchObject({ content: 'from a window', from });
  });

  it('opens the window\'s session as the chat it belongs to, not a new one', async () => {
    const chatId = await chatInSharedSession();
    transcript([...chatTurn, ...windowTurn]);
    await expect(service.openSessionAsChat(pid, projectDir, { sessionId: 'shared', transcriptPath: shared.transcript! })).resolves.toBe(chatId);
    expect(service.listSessions(projectDir)).toHaveLength(1);
    expect(service.loadSession(pid, projectDir)!.messages.map((m) => m.content)).toEqual(['hi', 'Hello', 'typed in the window', 'window reply']);
  });
});
