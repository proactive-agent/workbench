/**
 * The messaging tools of chats and agent windows: list_sessions names the project's chats and
 * windows (a window with the name SendMessage reaches it by), message_chat delivers to a chat by
 * its name and says what happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TerminalProcess } from '../../terminal/types';
import type { SessionMessageOrigin } from '../../../shared/types';

const liveSession = vi.hoisted(() => vi.fn());
vi.mock('../live-sessions', () => ({ windowLiveSession: liveSession }));
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => settings.value }));

import { setChatSource, setWindowSource } from '../directory';
import { runSessionTool, type SessionToolContext } from '../tools';
import { chatSessionName } from '../../../shared/utils/session-names';

const deliver = vi.fn();
const chatA = 'session-1794000000000';
const chatB = 'session-1794000000001';
const nameA = chatSessionName(chatA)!;
const nameB = chatSessionName(chatB)!;

const terminal = (id: string, projectPath: string, isCLIMode: boolean, title: string) =>
  ({ id, projectPath, isCLIMode, title } as unknown as TerminalProcess);

const context = (self: SessionMessageOrigin = { kind: 'chat', name: nameA, title: 'A' }): SessionToolContext => ({
  projectId: 'p1',
  projectPath: '/project',
  self: () => self,
});

beforeEach(() => {
  deliver.mockReset();
  liveSession.mockReset();
  setChatSource({
    list: () => [{ chatId: chatA, title: 'A', replying: false }, { chatId: chatB, title: 'B', replying: true }],
    deliver,
  });
  setWindowSource(() => [
    terminal('aaaaaaaa-1111-2222-3333-444444444444', '/project', true, 'Agent 1'),
    terminal('bbbbbbbb-1111-2222-3333-444444444444', '/project', false, 'Shell'),
    terminal('cccccccc-1111-2222-3333-444444444444', '/other', true, 'Elsewhere'),
  ]);
});

describe('list_sessions', () => {
  it("lists the project's chats and agent windows by name, with the SendMessage name of a live window", async () => {
    liveSession.mockImplementation(async (t: TerminalProcess) => (t.isCLIMode ? { name: 'workbench-7f', status: 'idle' } : undefined));
    const result = await runSessionTool(context(), 'list_sessions', {}) as {
      chats: Array<Record<string, unknown>>;
      agentWindows: Array<Record<string, unknown>>;
    };
    expect(result.chats).toEqual([
      { name: nameA, title: 'A', replyingNow: false, you: true },
      { name: nameB, title: 'B', replyingNow: true },
    ]);
    expect(result.agentWindows).toEqual([
      { name: 'agent-aaaaaaaa', title: 'Agent 1', claudeCodeRunning: true, sendMessageTo: 'workbench-7f', status: 'idle' },
      { name: 'agent-bbbbbbbb', title: 'Shell', claudeCodeRunning: false },
    ]);
  });
});

describe('message_chat', () => {
  it('delivers to a chat by its name, from the caller', async () => {
    deliver.mockResolvedValue({ status: 'queued' });
    const self = { kind: 'agent' as const, name: 'agent-aaaaaaaa', title: 'Agent 1' };
    const outcome = await runSessionTool(context(self), 'message_chat', { chat: nameB, message: ' The API changed ' });
    expect(deliver).toHaveBeenCalledWith('p1', '/project', chatB, self, 'The API changed');
    expect(outcome).toMatch(/^delivered: .* once that reply ends/);
  });

  it('says why it sent nothing', async () => {
    expect(await runSessionTool(context(), 'message_chat', { chat: 'agent-aaaaaaaa', message: 'x' })).toMatch(/^not sent: .* not a chat name/);
    expect(await runSessionTool(context(), 'message_chat', { chat: nameA, message: 'x' })).toBe('not sent: that is this chat');
    expect(await runSessionTool(context(), 'message_chat', { chat: nameB, message: '  ' })).toBe('not sent: the message is empty');
    expect(await runSessionTool(context(), 'message_chat', { chat: nameB, message: 'x'.repeat(8001) })).toMatch(/^not sent: .* 8001 characters/);
    deliver.mockResolvedValue({ status: 'notFound' });
    expect(await runSessionTool(context(), 'message_chat', { chat: nameB, message: 'x' })).toMatch(/^not sent: this project has no chat/);
  });

  it('sends nothing once messaging is switched off', async () => {
    settings.value = { claudeCodeTasks: { sessionMessages: false } };
    expect(await runSessionTool(context(), 'message_chat', { chat: nameB, message: 'x' })).toMatch(/^not available: .* off/);
    expect(deliver).not.toHaveBeenCalled();
    settings.value = {};
  });
});
