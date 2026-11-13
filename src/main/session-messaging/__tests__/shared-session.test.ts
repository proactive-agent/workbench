/**
 * A chat's Claude Code session open in an agent window too (shared-session.ts): the window running
 * it is found by its live session or the one it last ran, its working state comes from
 * `claude agents` before its output, and a chat's reply holds the window read-only, then has it
 * resume the session with the chat's turn
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../../terminal/types';

const state = vi.hoisted(() => ({
  windows: [] as Array<Partial<TerminalProcess>>,
  live: new Map<string, { sessionId: string; status?: string }>(),
  own: new Map<string, string>(),
  outputBusy: new Set<string>(),
  reopened: [] as Array<[string, string]>,
  holds: [] as string[],
  released: [] as string[],
}));

vi.mock('../directory', () => ({
  projectWindows: (projectPath: string) => state.windows.filter((w) => w.projectPath === projectPath),
  reopenWindowSession: async (terminalId: string, sessionId: string) => {
    state.reopened.push([terminalId, sessionId]);
  },
}));
vi.mock('../live-sessions', () => ({ windowLiveSession: async (terminal: TerminalProcess) => state.live.get(terminal.id) }));
vi.mock('../../terminal/cli-integration-handler', () => ({
  windowSessionAccount: async (terminal: TerminalProcess) => ({ own: state.own.has(terminal.id) ? { sessionId: state.own.get(terminal.id) } : undefined, configDir: undefined }),
}));
vi.mock('../../terminal/terminal-event-handler', () => ({ isClaudeBusyNow: (id: string) => state.outputBusy.has(id) }));
vi.mock('../receiving', () => ({
  holdForChatReply: (id: string) => state.holds.push(id),
  releaseChatReply: (id: string) => state.released.push(id),
}));

import { busyWindowOfSession, sessionWindow, shareSessionForReply } from '../shared-session';

const chat = { kind: 'chat' as const, name: 'chat-abc', title: 'Release notes' };
const window = (id: string, extra: Partial<TerminalProcess> = {}): Partial<TerminalProcess> => ({ id, projectPath: '/p', isCLIMode: true, ...extra });

describe('a chat session shared with an agent window', () => {
  beforeEach(() => {
    state.windows = [];
    state.live.clear();
    state.own.clear();
    state.outputBusy.clear();
    state.reopened = [];
    state.holds = [];
    state.released = [];
  });

  it("finds the window by the session its Claude Code runs, else the one it last ran, a task follower's never", async () => {
    state.windows = [window('follower', { follower: { handleInput() {}, stop() {} } }), window('shell', { isCLIMode: false }), window('live')];
    state.own.set('follower', 's1');
    state.own.set('shell', 's1');
    state.live.set('live', { sessionId: 's2', status: 'idle' });

    expect((await sessionWindow('/p', 's2'))?.terminal.id).toBe('live');
    // Back at its shell, the window that last ran it can resume it
    expect((await sessionWindow('/p', 's1'))?.terminal.id).toBe('shell');
    expect(await sessionWindow('/p', 'other')).toBeUndefined();
    expect(await sessionWindow('/elsewhere', 's2')).toBeUndefined();
  });

  it("takes Claude Code's own status over the window's output, which can miss a turn's end", async () => {
    state.windows = [window('w')];
    state.live.set('w', { sessionId: 's', status: 'idle' });
    state.outputBusy.add('w');
    expect(await busyWindowOfSession('/p', 's')).toBeUndefined();

    state.live.set('w', { sessionId: 's', status: 'busy' });
    expect((await busyWindowOfSession('/p', 's'))?.id).toBe('w');

    // No status reported: the output says
    state.live.set('w', { sessionId: 's' });
    expect((await busyWindowOfSession('/p', 's'))?.id).toBe('w');
  });

  it("holds the window read-only for a chat's reply, then has it resume the session with the chat's turn", async () => {
    state.windows = [window('w')];
    state.live.set('w', { sessionId: 's', status: 'idle' });
    const release = await shareSessionForReply('/p', 's', chat);
    expect(state.holds).toEqual(['w']);
    await release();
    expect(state.released).toEqual(['w']);
    expect(state.reopened).toEqual([['w', 's']]);
  });

  it('leaves a window that moved on to another session, or works on something the user took it over for', async () => {
    state.windows = [window('w')];
    state.live.set('w', { sessionId: 's', status: 'idle' });
    let release = await shareSessionForReply('/p', 's', chat);
    state.live.set('w', { sessionId: 'other', status: 'idle' });
    await release();
    expect(state.reopened).toEqual([]);

    state.live.set('w', { sessionId: 's', status: 'idle' });
    release = await shareSessionForReply('/p', 's', chat);
    state.live.set('w', { sessionId: 's', status: 'busy' });
    await release();
    expect(state.reopened).toEqual([]);
    expect(state.released).toEqual(['w', 'w']);
  });

  it('holds nothing without a window running the session', async () => {
    const release = await shareSessionForReply('/p', 's', chat);
    await release();
    expect(state.holds).toEqual([]);
    expect(state.reopened).toEqual([]);
  });
});
