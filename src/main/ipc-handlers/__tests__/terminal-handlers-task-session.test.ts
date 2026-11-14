/**
 * TERMINAL_RESUME_TASK_SESSION: opening a task's Claude Code session in an agent window.
 *
 * A task id is only unique within a project, so the request names the task's project and the
 * window follows that project's run. Without a project the lookup stays tolerant, which is what
 * a window restored from a saved session or an older renderer still relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}));

vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: vi.fn(async () => ({})) }));
vi.mock('../../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));
vi.mock('../../claude-profile/usage-monitor', () => ({ getUsageMonitor: vi.fn() }));
vi.mock('../../terminal-manager', () => ({ TerminalManager: class {} }));
vi.mock('../../claude-profile/session-utils', () => ({ migrateSession: vi.fn() }));
vi.mock('../../terminal/session-handler', () => ({ findMostRecentClaudeSession: vi.fn() }));
vi.mock('../../claude-profile/profile-utils', () => ({ createProfileDirectory: vi.fn() }));
vi.mock('../../utils/config-path-validator', () => ({ isValidConfigDir: vi.fn(() => true) }));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: vi.fn() }));
vi.mock('../../claude-profile/config-dir-paths', () => ({ isDefaultClaudeConfigDir: vi.fn(() => false) }));
vi.mock('../claude-code-handlers', () => ({ openTerminalWithCommand: vi.fn() }));

import { IPC_CHANNELS } from '../../../shared/constants';
import type { TerminalTaskSessionOptions } from '../../../shared/types';
import type { AgentManager } from '../../agent/agent-manager';
import type { TerminalManager } from '../../terminal-manager';
import { registerTerminalHandlers } from '../terminal-handlers';

/** A run of one task in one project, as the window sees it: is it going, and on which session */
interface Run {
  taskId: string;
  projectId: string;
  sessionId: string;
}

/**
 * A stand-in for AgentManager's run lookup that answers the way `keyOf` does: a named project
 * selects that project's run, and a bare task id is answered only while it means one run.
 */
function fakeAgentManager(runs: Run[]): Pick<AgentManager, 'isRunning' | 'getRunSession' | 'getRunningTasksByProfile'> {
  const find = (taskId: string, projectId?: string): Run | undefined => {
    const matches = runs.filter((run) => run.taskId === taskId && (!projectId || run.projectId === projectId));
    return matches.length === 1 ? matches[0] : undefined;
  };
  return {
    isRunning: (taskId: string, projectId?: string) => find(taskId, projectId) !== undefined,
    getRunSession: (taskId: string, projectId?: string) => {
      const run = find(taskId, projectId);
      return run ? { sessionId: run.sessionId } : undefined;
    },
    getRunningTasksByProfile: () => ({ byProfile: {}, totalRunning: runs.length })
  } as Pick<AgentManager, 'isRunning' | 'getRunSession' | 'getRunningTasksByProfile'>;
}

const followTaskSession = vi.fn();
const resumeTaskSessionAsync = vi.fn(async () => undefined);

/** Register the handlers over a fresh set of runs and return the resume request's handler */
function given(runs: Run[]): (id: string, options: TerminalTaskSessionOptions) => Promise<void> {
  handlers.clear();
  registerTerminalHandlers(
    { followTaskSession, resumeTaskSessionAsync } as unknown as TerminalManager,
    () => null,
    fakeAgentManager(runs)
  );
  const handler = handlers.get(IPC_CHANNELS.TERMINAL_RESUME_TASK_SESSION);
  if (!handler) throw new Error('the resume handler was not registered');
  return async (id, options) => {
    handler({}, id, options);
    // The handler does its work in a detached async IIFE, so let the microtasks settle
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
}

/** The run the window ended up following, as the follow call's own lookup reports it */
function followedSession(): string | undefined {
  const run = followTaskSession.mock.calls[0]?.[2];
  return run?.getSession()?.sessionId;
}

const base = { sessionId: 'session-a', cwd: '/projects/a/.workbench/worktrees/tasks/001-fix', taskId: 'task-1' };

describe('TERMINAL_RESUME_TASK_SESSION', () => {
  beforeEach(() => {
    followTaskSession.mockClear();
    resumeTaskSessionAsync.mockClear();
  });

  it("follows the named project's run when two projects run a task of the same id", async () => {
    const resume = given([
      { taskId: 'task-1', projectId: 'project-a', sessionId: 'session-a' },
      { taskId: 'task-1', projectId: 'project-b', sessionId: 'session-b' }
    ]);

    await resume('terminal-1', { ...base, sessionId: 'session-b', projectId: 'project-b' });

    expect(followTaskSession).toHaveBeenCalledTimes(1);
    expect(followedSession()).toBe('session-b');
    expect(resumeTaskSessionAsync).not.toHaveBeenCalled();
  });

  it('follows a single project run named by its project', async () => {
    const resume = given([{ taskId: 'task-1', projectId: 'project-a', sessionId: 'session-a' }]);

    await resume('terminal-1', { ...base, projectId: 'project-a' });

    expect(followTaskSession).toHaveBeenCalledTimes(1);
    expect(followedSession()).toBe('session-a');
  });

  it('still follows an unambiguous run when the request names no project', async () => {
    const resume = given([{ taskId: 'task-1', projectId: 'project-a', sessionId: 'session-a' }]);

    await resume('terminal-1', base);

    expect(followTaskSession).toHaveBeenCalledTimes(1);
    expect(followedSession()).toBe('session-a');
    expect(resumeTaskSessionAsync).not.toHaveBeenCalled();
  });

  it('resumes the session it was handed when no project is named and the task id is ambiguous', async () => {
    const resume = given([
      { taskId: 'task-1', projectId: 'project-a', sessionId: 'session-a' },
      { taskId: 'task-1', projectId: 'project-b', sessionId: 'session-b' }
    ]);

    await resume('terminal-1', { ...base, sessionId: 'session-b' });

    expect(followTaskSession).not.toHaveBeenCalled();
    expect(resumeTaskSessionAsync).toHaveBeenCalledWith(
      'terminal-1',
      expect.objectContaining({ sessionId: 'session-b' }),
      false
    );
  });

  it('resumes the session when the task is not running at all', async () => {
    const resume = given([]);

    await resume('terminal-1', { ...base, projectId: 'project-a' });

    expect(followTaskSession).not.toHaveBeenCalled();
    expect(resumeTaskSessionAsync).toHaveBeenCalledTimes(1);
  });
});
