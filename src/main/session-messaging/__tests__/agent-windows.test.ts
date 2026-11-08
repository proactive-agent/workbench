import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../../terminal/types';

const recorded = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
const windows = vi.hoisted(() => ({ value: [] as TerminalProcess[] }));
const live = vi.hoisted(() => ({ value: new Map<string, { name: string }>() }));

vi.mock('../../agent-session-store', () => ({ readAgentSessions: async () => recorded.value, noteWindowSession: () => {} }));
vi.mock('../../terminal/claude-sessions', () => ({ readSessionName: async () => 'Failing CI' }));
vi.mock('../../terminal/cli-integration-handler', () => ({ sessionSearchDirs: () => ['/home/me/.claude'] }));
vi.mock('../../platform/shell-runtime', () => ({ toRuntimePath: (value: string) => value }));
vi.mock('../directory', () => ({
  projectWindows: () => windows.value,
  findWindow: (id: string) => windows.value.find((terminal) => terminal.id === id),
}));
vi.mock('../live-sessions', () => ({ windowLiveSession: async (terminal: TerminalProcess) => live.value.get(terminal.id) }));

import { ensureAgentWindowRunning, findAgentWindow, setAgentWindowOpener, windowMessaged } from '../agent-windows';
import { isReceiving, setReceivingHooks, stopReceiving } from '../receiving';

const terminalId = '1a19c850-1111-2222-3333-444444444444';

describe('agent windows by name', () => {
  beforeEach(() => {
    recorded.value = [
      { sessionId: 'old', terminalId, startedAt: '2026-11-01' },
      { sessionId: 'latest', terminalId, configDir: '/home/me/.claude-work', startedAt: '2026-11-02' },
    ];
    windows.value = [];
    live.value.clear();
  });

  it('finds a closed window by its name, titled after its last session', async () => {
    expect(await findAgentWindow('/project', 'agent-1a19c850')).toEqual({ terminalId, title: 'Failing CI', open: false });
    expect(await findAgentWindow('/project', 'agent-ffffffff')).toBeNull();
  });

  it('opens a closed window again on its last session and waits for its Claude Code', async () => {
    vi.useFakeTimers();
    const opener = vi.fn(() => {
      windows.value = [{ id: terminalId, title: 'Failing CI' } as TerminalProcess];
      live.value.set(terminalId, { name: 'workbench-d7' });
    });
    setAgentWindowOpener(opener);
    const running = ensureAgentWindowRunning('/project', 'agent-1a19c850');
    // A second message while it opens opens it once
    const again = ensureAgentWindowRunning('/project', 'agent-1a19c850');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toBe(true);
    expect(await again).toBe(true);
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith({
      projectPath: '/project',
      terminalId,
      title: 'Failing CI',
      sessionId: 'latest',
      configDir: '/home/me/.claude-work',
    });
    vi.useRealTimers();
  });

  it('opens nothing for a name no window had', async () => {
    const opener = vi.fn();
    setAgentWindowOpener(opener);
    expect(await ensureAgentWindowRunning('/project', 'agent-ffffffff')).toBe(false);
    expect(opener).not.toHaveBeenCalled();
  });

  it('makes the window a SendMessage reaches read-only', async () => {
    setReceivingHooks({ notify: () => {}, isBusy: () => false });
    windows.value = [{ id: terminalId } as TerminalProcess];
    live.value.set(terminalId, { name: 'workbench-d7' });
    await windowMessaged('/project', 'workbench-d7', { kind: 'chat', name: 'chat-abc' });
    expect(isReceiving(terminalId)).toBe(true);
    stopReceiving(terminalId);
  });
});
