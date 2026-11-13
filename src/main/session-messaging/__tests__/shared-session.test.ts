/**
 * A chat's Claude Code session open in an agent window too (shared-session.ts): only windows that
 * recorded the session are looked at, one running Claude Code counts while `claude agents` says it
 * runs that session (busy unless Claude Code reports it idle), and a chat's reply holds the window
 * read-only, then has it resume the session unless another reply holds it by then
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../../terminal/types';

const state = vi.hoisted(() => ({
  windows: [] as Array<Partial<TerminalProcess>>,
  live: new Map<string, { sessionId: string; status?: string }>(),
  liveAsked: [] as string[],
  own: new Map<string, string>(),
  started: new Map<string, string>(),
  outputBusy: new Set<string>(),
  idleShells: new Set<string>(),
  reopened: [] as Array<[string, string]>,
  holds: new Map<string, number>(),
}));

vi.mock('../directory', () => ({
  projectWindows: (projectPath: string) => state.windows.filter((w) => w.projectPath === projectPath),
  reopenWindowSession: async (terminalId: string, sessionId: string) => {
    state.reopened.push([terminalId, sessionId]);
  },
}));
vi.mock('../live-sessions', () => ({
  windowLiveSession: async (terminal: TerminalProcess) => {
    state.liveAsked.push(terminal.id);
    return state.live.get(terminal.id);
  },
}));
vi.mock('../../agent-session-store', () => ({ windowOfSession: (sessionId: string) => state.started.get(sessionId) }));
vi.mock('../../terminal/cli-integration-handler', () => ({
  windowSessionAccount: async (terminal: TerminalProcess) => ({ own: state.own.has(terminal.id) ? { sessionId: state.own.get(terminal.id) } : undefined, configDir: undefined }),
}));
vi.mock('../../terminal/terminal-event-handler', () => ({ isClaudeBusyNow: (id: string) => state.outputBusy.has(id) }));
vi.mock('../agent-windows', () => ({ shellIsIdle: (terminal: TerminalProcess) => state.idleShells.has(terminal.id) }));
vi.mock('../receiving', () => ({
  holdForChatReply: (id: string) => {
    state.holds.set(id, (state.holds.get(id) ?? 0) + 1);
    return state.holds.get(id)!;
  },
  heldForChatReply: (id: string) => (state.holds.get(id) ?? 0) > 0,
  releaseChatReply: (id: string) => {
    state.holds.set(id, (state.holds.get(id) ?? 1) - 1);
    return state.holds.get(id)! > 0;
  },
}));

import { sessionWindow, shareSessionForReply } from '../shared-session';

const chat = { kind: 'chat' as const, name: 'chat-abc', title: 'Release notes' };
const window = (id: string, extra: Partial<TerminalProcess> = {}): Partial<TerminalProcess> => ({ id, projectPath: '/p', isCLIMode: true, ...extra });

describe('a chat session shared with an agent window', () => {
  beforeEach(() => {
    state.windows = [];
    state.live.clear();
    state.liveAsked = [];
    state.own.clear();
    state.started.clear();
    state.outputBusy.clear();
    state.idleShells.clear();
    state.reopened = [];
    state.holds.clear();
  });

  it("looks only at windows that recorded the session, without asking `claude agents` about others", async () => {
    state.windows = [window('other'), window('mine')];
    state.live.set('other', { sessionId: 's', status: 'idle' });
    state.live.set('mine', { sessionId: 's', status: 'idle' });
    state.own.set('mine', 's');
    expect((await sessionWindow('/p', 's'))?.terminal.id).toBe('mine');
    expect(state.liveAsked).toEqual(['mine']);

    // Started or resumed in this run (the run's own record)
    state.own.clear();
    state.started.set('s', 'other');
    expect((await sessionWindow('/p', 's'))?.terminal.id).toBe('other');
    expect(await sessionWindow('/p', 'unknown')).toBeUndefined();
  });

  it('leaves a window that moved on to another session (/clear, /resume), and a task follower', async () => {
    state.windows = [window('w'), window('follower', { follower: { handleInput() {}, stop() {} } })];
    state.own.set('w', 's');
    state.own.set('follower', 's');
    state.live.set('w', { sessionId: 'after-clear', status: 'idle' });
    expect(await sessionWindow('/p', 's')).toBeUndefined();
  });

  it("is busy unless Claude Code reports it idle (waiting on a permission prompt too), its output only without a status", async () => {
    state.windows = [window('w')];
    state.own.set('w', 's');
    state.live.set('w', { sessionId: 's', status: 'idle' });
    state.outputBusy.add('w');
    expect((await sessionWindow('/p', 's'))?.busy).toBe(false);
    state.live.set('w', { sessionId: 's', status: 'waiting' });
    expect((await sessionWindow('/p', 's'))?.busy).toBe(true);
    state.live.set('w', { sessionId: 's' });
    expect((await sessionWindow('/p', 's'))?.busy).toBe(true);
  });

  it('finds a window back at its shell, which can resume the session only with nothing else running there', async () => {
    state.windows = [window('w', { isCLIMode: false })];
    state.own.set('w', 's');
    expect(await sessionWindow('/p', 's')).toMatchObject({ busy: false, atShell: true, shellIdle: false });
    state.idleShells.add('w');
    expect(await sessionWindow('/p', 's')).toMatchObject({ atShell: true, shellIdle: true });
  });

  it("holds the window read-only for a chat's reply, then has it resume the session with the chat's turn", async () => {
    state.windows = [window('w')];
    state.own.set('w', 's');
    state.live.set('w', { sessionId: 's', status: 'idle' });
    const release = shareSessionForReply('/p', (await sessionWindow('/p', 's'))!, 's', chat);
    expect(state.holds.get('w')).toBe(1);
    await release();
    expect(state.holds.get('w')).toBe(0);
    expect(state.reopened).toEqual([['w', 's']]);
  });

  it('leaves the window to a reply that holds it by then, and one that moved on or works', async () => {
    state.windows = [window('w')];
    state.own.set('w', 's');
    state.live.set('w', { sessionId: 's', status: 'idle' });
    const found = (await sessionWindow('/p', 's'))!;
    const first = shareSessionForReply('/p', found, 's', chat);
    const second = shareSessionForReply('/p', found, 's', chat);
    await first();
    expect(state.reopened).toEqual([]);

    state.live.set('w', { sessionId: 's', status: 'busy' });
    await second();
    expect(state.reopened).toEqual([]);
  });

  it("holds no window back at its shell (the user may be working there)", async () => {
    state.windows = [window('w', { isCLIMode: false })];
    state.own.set('w', 's');
    const release = shareSessionForReply('/p', (await sessionWindow('/p', 's'))!, 's', chat);
    await release();
    expect(state.holds.size).toBe(0);
    expect(state.reopened).toEqual([]);
  });
});
