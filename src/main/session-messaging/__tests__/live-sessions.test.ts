import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../../terminal/types';

const listed = vi.hoisted(() => ({ value: [] as unknown[] }));
/** Each process's parent */
const parents = vi.hoisted(() => new Map<number, number>());

vi.mock('fs/promises', () => ({
  readFile: async (path: string) => {
    const pid = Number(/\/proc\/(\d+)\/stat/.exec(path)?.[1]);
    const ppid = parents.get(pid);
    if (!ppid) throw new Error('gone');
    return `${pid} (claude) S ${ppid} 1 1`;
  },
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => ({ found: true, path: '/bin/claude' }) }));
const runTool = vi.hoisted(() => vi.fn());
vi.mock('../../platform/runtime-exec', () => ({ runTool }));
vi.mock('../../platform/shell-runtime', () => ({ isWslRuntime: () => false }));
vi.mock('../../platform', () => ({ isLinux: () => true, isMacOS: () => false }));
const account = vi.hoisted(() => ({ value: { own: { sessionId: 'session-a' } as { sessionId: string } | undefined, configDir: undefined as string | undefined } }));
vi.mock('../../terminal/cli-integration-handler', () => ({ windowSessionAccount: async () => account.value }));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getProfile: (id: string) => (id === 'task-account' ? { configDir: '/home/me/.claude-task' } : undefined) }),
}));
vi.mock('../../platform/claude-home', () => ({ expandClaudeHome: (dir: string) => dir }));
vi.mock('../../claude-profile/config-dir-paths', () => ({ withClaudeConfigDir: (env: NodeJS.ProcessEnv) => env }));

import { liveClaudeSessions, resetLiveSessionsCache, windowLiveSession } from '../live-sessions';

const terminal = { id: 'window-1', isCLIMode: true, projectPath: '/project', pty: { pid: 100 } } as unknown as TerminalProcess;

describe('windowLiveSession', () => {
  beforeEach(() => {
    resetLiveSessionsCache();
    parents.clear();
    runTool.mockReset();
    runTool.mockImplementation(async () => ({ stdout: JSON.stringify(listed.value) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    account.value = { own: { sessionId: 'session-a' }, configDir: undefined };
  });

  it("also looks under the account the window's Claude Code was started on, without a recorded session", async () => {
    account.value = { own: undefined, configDir: '/home/me/.claude' };
    parents.set(700, 100);
    runTool.mockImplementation(async (_tool: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => ({
      stdout: JSON.stringify(options.env.CLAUDE_CONFIG_DIR === '/home/me/.claude-task' ? [{ pid: 700, sessionId: 'task-session', name: 'project-t1' }] : []),
    }));
    const window = { ...terminal, claudeProfileId: 'task-account' } as TerminalProcess;
    expect((await windowLiveSession(window))?.name).toBe('project-t1');
  });

  it('shares a listing still running, however long it takes', async () => {
    let finish: (value: unknown) => void = () => {};
    runTool.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.useFakeTimers();
    const first = liveClaudeSessions();
    await vi.advanceTimersByTimeAsync(10_000);
    const second = liveClaudeSessions();
    finish({ stdout: '[]' });
    await Promise.all([first, second]);
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('takes the only process running the recorded session', async () => {
    listed.value = [{ pid: 300, sessionId: 'session-a', name: 'project-a1' }];
    expect((await windowLiveSession(terminal))?.name).toBe('project-a1');
  });

  it('takes the process under the window when several run the recorded session', async () => {
    // A closed window's Claude Code left running (its shell gone), then this window's
    parents.set(300, 1);
    parents.set(400, 100);
    listed.value = [
      { pid: 300, sessionId: 'session-a', name: 'project-c7' },
      { pid: 400, sessionId: 'session-a', name: 'project-d7' },
    ];
    expect((await windowLiveSession(terminal))?.name).toBe('project-d7');
  });

  it('finds the process under the window when the recorded session is not running', async () => {
    parents.set(500, 100);
    listed.value = [{ pid: 500, sessionId: 'session-b', name: 'project-b2' }];
    expect((await windowLiveSession(terminal))?.name).toBe('project-b2');
  });
});
