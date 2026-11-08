import { beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../../platform/runtime-exec', () => ({ runTool: async () => ({ stdout: JSON.stringify(listed.value) }) }));
vi.mock('../../platform/shell-runtime', () => ({ isWslRuntime: () => false }));
vi.mock('../../platform', () => ({ isLinux: () => true, isMacOS: () => false }));
vi.mock('../../agent-session-store', () => ({ lastAgentSession: async () => ({ sessionId: 'session-a' }) }));
vi.mock('../../platform/claude-home', () => ({ expandClaudeHome: (dir: string) => dir }));
vi.mock('../../claude-profile/config-dir-paths', () => ({ withClaudeConfigDir: (env: NodeJS.ProcessEnv) => env }));
vi.mock('../../claude-profile-manager', () => ({ getClaudeProfileManager: () => ({ getActiveProfile: () => undefined }) }));

import { resetLiveSessionsCache, windowLiveSession } from '../live-sessions';

const terminal = { id: 'window-1', isCLIMode: true, projectPath: '/project', pty: { pid: 100 } } as unknown as TerminalProcess;

describe('windowLiveSession', () => {
  beforeEach(() => {
    resetLiveSessionsCache();
    parents.clear();
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
