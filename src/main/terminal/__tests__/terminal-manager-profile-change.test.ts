import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pty-manager', () => ({}));
vi.mock('../session-handler', () => ({ persistAllSessionsAsync: vi.fn(async () => undefined) }));
vi.mock('../terminal-lifecycle', () => ({}));
vi.mock('../terminal-event-handler', () => ({ createEventCallbacks: vi.fn(() => ({})) }));
vi.mock('../cli-integration-handler', () => ({}));
vi.mock('../session-follower', () => ({ SessionFollower: vi.fn() }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../../terminal-session-store', () => ({ SESSION_SAVE_INTERVAL_MS: 60_000 }));

import { TerminalManager } from '../terminal-manager';
import type { TerminalProcess } from '../types';

function windowOf(id: string, fields: Partial<TerminalProcess>): TerminalProcess {
  return { id, cwd: '/project', projectPath: '/project', isCLIMode: false, ...fields } as TerminalProcess;
}

describe('TerminalManager.getTerminalsForProfileChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists only the agent windows running Claude Code, not plain terminals or windows following a task', () => {
    const manager = new TerminalManager(() => null);
    const terminals = (manager as unknown as { terminals: Map<string, TerminalProcess> }).terminals;
    terminals.set('agent', windowOf('agent', { isCLIMode: true, dangerouslySkipPermissions: true }));
    terminals.set('shell', windowOf('shell', { isCLIMode: false }));
    terminals.set('following', windowOf('following', { isCLIMode: true, follower: {} as TerminalProcess['follower'] }));

    const listed = manager.getTerminalsForProfileChange();

    expect(listed.map((t) => t.id)).toEqual(['agent']);
    expect(listed[0]).toMatchObject({ isCLIMode: true, dangerouslySkipPermissions: true, cwd: '/project' });
  });
});
