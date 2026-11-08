/**
 * Messages from the project's other chats and agent windows: shown in the chat with their sender,
 * framed for Claude as another session's, answered by the chat's own reply (after the reply it is
 * writing), and refused for a chat that is gone. And an agent window's session opened as a chat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = vi.fn();
const replying = new Set<string>();

vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  class FakeExecutor extends EventEmitter {
    cancelSession() { return false; }
    isSessionActive(_projectId: string, chatId?: string) { return !!chatId && replying.has(chatId); }
    execute(...args: unknown[]) { return execute(...args); }
  }
  return { InsightsExecutor: FakeExecutor };
});
vi.mock('../insights/config', () => ({ InsightsConfig: class { configure() {} } }));
const ensureWindow = vi.fn(async () => true);
vi.mock('../session-messaging/agent-windows', () => ({ ensureAgentWindowRunning: (...args: unknown[]) => ensureWindow(...(args as [])) }));

import { insightsService as service } from '../insights-service';
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

  it('keeps the limit for messages that waited for a reply, and leaves them waiting after a stop', async () => {
    const chatId = await chatWithOneReply();
    replying.add(chatId);
    for (let n = 1; n <= 7; n++) {
      await expect(service.receiveMessage(pid, projectDir, chatId, from, `burst ${n}`)).resolves.toEqual({ status: 'queued' });
    }
    // A reply the user stops: nothing waiting starts
    replying.delete(chatId);
    execute.mockResolvedValueOnce({ fullResponse: '', toolsUsed: [], stopped: true });
    await service.sendMessage(pid, projectDir, 'question');
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);

    // A reply that ends: the waiting ones are answered one after another, five at most
    for (let n = 1; n <= 5; n++) execute.mockResolvedValueOnce({ fullResponse: `answer ${n}`, toolsUsed: [] });
    execute.mockResolvedValueOnce({ fullResponse: 'to the user', toolsUsed: [] });
    await service.sendMessage(pid, projectDir, 'again');
    for (let n = 0; n < 20; n++) await flush();
    expect(execute).toHaveBeenCalledTimes(3 + 5);
    const contents = service.loadSession(pid, projectDir)!.messages.map((m) => m.content);
    // The last two are shown without a reply
    expect(contents.slice(-2)).toEqual(['burst 6', 'burst 7']);
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

    // Opened again later: the same chat, with what was said in the window since
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
