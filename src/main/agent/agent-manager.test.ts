/**
 * Tests for AgentManager: wiring of ClaudeTaskRun (Claude Code task runner) to manager events
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import type { Project, Task } from '../../shared/types';
import type { TaskRunCallbacks, TaskRunConfig, TaskRunOutcome } from '../claude-code/task-runner';

interface MockRun {
  config: TaskRunConfig;
  callbacks: TaskRunCallbacks;
  stop: ReturnType<typeof vi.fn>;
  finish: (outcome: TaskRunOutcome) => void;
}

const runs: MockRun[] = [];

// Runs leave out MCP servers that can't start; tests don't start any. `leftOut` connectors are
// left out as if their browser were open
const connectorMocks = vi.hoisted(() => ({
  leftOut: new Set<string>(),
  /** The run's own Playwright browser each call was given (a task's choice) */
  runBrowsers: [] as unknown[],
}));
vi.mock('../mcp-availability', () => ({
  usableMcpConnectorIds: async (
    ids: string[],
    _settings: unknown,
    onLeftOut?: (id: string, availability: unknown) => void,
    runBrowser?: unknown
  ) => {
    connectorMocks.runBrowsers.push(runBrowser);
    return ids.filter((id) => {
      if (!connectorMocks.leftOut.has(id)) return true;
      onLeftOut?.(id, { state: 'unavailable', browserOpen: true });
      return false;
    });
  },
  describeLeftOutConnector: (id: string) => `${id} connector left out of this run: the browser is open`,
}));
vi.mock('../claude-code/task-runner', () => ({
  ClaudeTaskRun: class {
    private resolve!: (outcome: TaskRunOutcome) => void;
    private readonly done: Promise<TaskRunOutcome>;
    stop = vi.fn(() => this.resolve({ status: 'stopped' }));
    constructor(config: TaskRunConfig, callbacks: TaskRunCallbacks) {
      this.done = new Promise((resolve) => { this.resolve = resolve; });
      runs.push({ config, callbacks, stop: this.stop, finish: (outcome) => this.resolve(outcome) });
    }
    run() {
      return this.done;
    }
  },
  loadClaudeRunInfo: vi.fn(() => null),
  resetClaudeRunInfo: vi.fn(),
  isClaudeRunFinished: vi.fn(() => false),
}));

vi.mock('../worktree', () => ({
  createOrGetWorktree: vi.fn(async (_projectPath: string, specId: string) => ({
    worktreePath: `/project/.workbench/worktrees/tasks/${specId}`,
    branch: `workbench/${specId}`,
  })),
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({ claudeCodeTasks: { triage: 'fixed', fixedModel: 'opus' } })),
}));

// The profiles still chosen (Settings and other tasks), which a copy's sweep keeps
vi.mock('../browser-profiles/choices-in-use', () => ({
  browserChoicesInUse: vi.fn(async (_projectPath: string, settingsChoice: unknown) => ({
    project: settingsChoice ? [settingsChoice] : [],
    all: settingsChoice ? [settingsChoice] : [],
  })),
}));

// Copies of the Playwright connector's browser profile: a folder per run, nothing on disk
vi.mock('../browser-profiles/profile-copy', () => ({
  prepareBrowserProfileCopy: vi.fn(async (_projectPath: string, choice: { id: string }, slot: string) => `/copies/${choice.id}/${slot}`),
  removeBrowserProfileCopy: vi.fn(async () => undefined),
  removeStaleBrowserProfileCopies: vi.fn(async () => undefined),
}));

vi.mock('../graphify', () => ({
  getGraphifyPromptContext: vi.fn(async () => null),
  isGraphifyEnabled: vi.fn(async () => false),
}));

vi.mock('../env-utils', () => ({
  getAugmentedEnvAsync: vi.fn(async () => ({ PATH: '/usr/bin' })),
}));

vi.mock('../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git'),
  getToolPathAsync: vi.fn(async () => 'git'),
}));

const profileManager = {
  getActiveProfile: vi.fn(() => ({ id: 'profile-a', name: 'Account A' })),
  getProfile: vi.fn((id: string) => ({ id, name: `Account ${id}` })),
  setActiveProfile: vi.fn(),
  recordRateLimitEvent: vi.fn(),
};
vi.mock('../claude-profile-manager', () => ({
  getClaudeProfileManager: () => profileManager,
}));

const registry = { registerOperation: vi.fn(), unregisterOperation: vi.fn() };
vi.mock('../claude-profile/operation-registry', () => ({
  getOperationRegistry: () => registry,
}));

vi.mock('../services/profile', () => ({
  getAPIProfileEnv: vi.fn(async () => ({})),
}));

vi.mock('../app-logger', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real one asks git; its own tests cover resolving and the branch that exists nowhere
vi.mock('../utils/base-branch', () => ({
  resolveBaseBranch: vi.fn(async (_cwd: string, wanted: string) => wanted),
  resolveDefaultBaseBranch: vi.fn(async () => 'master'),
}));

// git answers two questions here: whether the task's branch is already in the repository, and
// which branch the project has checked out. Nothing is in it by default. Hoisted, because the mock
// is built while another module's `import '../utils/git-exec'` is resolved
const mockGit = vi.hoisted(() => vi.fn(async (_args: string[], _options?: unknown) => ({ stdout: '', stderr: '' })));
vi.mock('../utils/git-exec', () => ({ git: mockGit }));

// A pending resync request of the task (task-resync/request.ts); none unless a test sets one
const pendingResync = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../task-resync/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../task-resync/request')>()),
  readResyncRequest: vi.fn(() => pendingResync.value),
}));

import { AgentManager } from './agent-manager';

const project = {
  id: 'project-1',
  name: 'Project',
  path: '/project',
  autoBuildPath: '.workbench',
  settings: { mainBranch: 'develop' },
} as unknown as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '001-add-login',
    specId: '001-add-login',
    projectId: 'project-1',
    title: 'Add login',
    description: 'Add a login page',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      attachedImages: [{ id: 'img', filename: 'mock.png', mimeType: 'image/png', size: 1, path: 'attachments/mock.png' }],
      mcpConnectors: ['context7'],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

/** Wait until the manager created the run (setup is async) */
async function nextRun(count: number): Promise<MockRun> {
  await vi.waitFor(() => expect(runs.length).toBe(count));
  return runs[count - 1];
}

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(async () => {
    runs.length = 0;
    vi.clearAllMocks();
    // Clearing a mock keeps whatever a test set on it, so the modules the run config asks about
    // its branches are put back the way every test but that one expects them
    mockGit.mockImplementation(async () => ({ stdout: '', stderr: '' }));
    const baseBranch = await import('../utils/base-branch');
    vi.mocked(baseBranch.resolveBaseBranch).mockImplementation(async (_cwd: string, wanted: string) => wanted);
    vi.mocked(baseBranch.resolveDefaultBaseBranch).mockImplementation(async () => 'master');
    manager = new AgentManager();
  });

  /**
   * A branch the user chose is never swapped for another, but when neither the task nor the project
   * names one there is no choice to honour: the repository is asked for its default instead of the
   * run assuming `main`, which no `master` project has.
   */
  it('asks the repo for its default branch only when no base branch was chosen', async () => {
    const { resolveBaseBranch, resolveDefaultBaseBranch } = await import('../utils/base-branch');

    const chosenOnTask = makeTask({ metadata: { baseBranch: 'upstream/release' } } as Partial<Task>);
    await manager.startTask('001-add-login', { project, task: chosenOnTask, mode: 'start' });
    expect((await nextRun(1)).config.baseBranch).toBe('upstream/release');
    expect(resolveDefaultBaseBranch).not.toHaveBeenCalled();

    // Chosen as the project's main branch, with nothing on the task
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    expect((await nextRun(2)).config.baseBranch).toBe('develop');
    expect(resolveDefaultBaseBranch).not.toHaveBeenCalled();

    // Nothing chosen anywhere
    const noMainBranch = { ...project, settings: {} } as unknown as Project;
    await manager.startTask('001-add-login', { project: noMainBranch, task: makeTask(), mode: 'start' });
    expect((await nextRun(3)).config.baseBranch).toBe('master');
    expect(resolveDefaultBaseBranch).toHaveBeenCalledWith('/project');
    expect(resolveBaseBranch).not.toHaveBeenCalledWith('/project', 'main');
  });

  /**
   * A task that needs no worktree can run in a directory that is not a git repository, so the
   * repository has no default branch to give. The value is only printed in that case, so the run
   * has to start anyway.
   */
  it('starts a worktree-less run in a directory with no branch to detect', async () => {
    const { resolveDefaultBaseBranch } = await import('../utils/base-branch');
    vi.mocked(resolveDefaultBaseBranch).mockRejectedValueOnce(
      new Error('This project has no branch to start the task from')
    );
    const noMainBranch = { ...project, settings: {} } as unknown as Project;
    const noWorktree = makeTask({ metadata: { useWorktree: false } } as Partial<Task>);

    await manager.startTask('001-add-login', { project: noMainBranch, task: noWorktree, mode: 'start' });

    const run = await nextRun(1);
    expect(run.config.worktreePath).toBe('/project');
    expect(run.config.baseBranch).toBe('main');
  });

  it('builds the run config from the task, project and settings', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    expect(run.config.worktreePath).toBe('/project/.workbench/worktrees/tasks/001-add-login');
    expect(run.config.branch).toBe('workbench/001-add-login');
    expect(run.config.baseBranch).toBe('develop');
    expect(run.config.specDir).toBe(path.join('/project', '.workbench', 'tasks', '001-add-login'));
    expect(run.config.attachments).toEqual([{
      path: path.join('/project', '.workbench', 'tasks', '001-add-login', 'attachments', 'mock.png'),
      filename: 'mock.png',
      mimeType: 'image/png',
    }]);
    expect(run.config.connectorIds).toEqual(['context7']);
    expect(run.config.settings.triage).toBe('fixed');
    expect(run.config.settings.fixedModel).toBe('opus');
    expect(run.config.mode).toBe('start');
    expect(manager.isRunning('001-add-login')).toBe(true);
    expect(registry.registerOperation).toHaveBeenCalledWith(
      'task:project-1:001-add-login', 'task-execution', 'profile-a', 'Account A', expect.any(Function), expect.anything()
    );
  });

  it('applies a pending local merge on start only to a task without a pull request', async () => {
    pendingResync.value = { ref: 'develop', into: 'develop', via: 'local', merged: [], at: '2026-10-01T00:00:00Z' };
    try {
      await manager.startTask('001-add-login', { project, task: makeTask({ status: 'human_review' }), mode: 'start' });
      expect((await nextRun(1)).config.resync).toEqual(expect.objectContaining({ ref: 'develop' }));
      const withPr = makeTask({ id: '002-pr', specId: '002-pr', status: 'human_review' });
      withPr.metadata = { ...withPr.metadata, prUrl: 'https://github.com/o/r/pull/2', prState: 'open' } as Task['metadata'];
      await manager.startTask('002-pr', { project, task: withPr, mode: 'start' });
      expect((await nextRun(2)).config.resync).toBeUndefined();
    } finally {
      pendingResync.value = undefined;
    }
  });

  it("says in the task's log when a chosen connector is left out of the run", async () => {
    connectorMocks.leftOut.add('playwright');
    try {
      const logs: string[] = [];
      manager.on('log', (_taskId: string, line: string) => logs.push(line));
      const task = makeTask({ metadata: { mcpConnectors: ['context7', 'playwright'] } } as Partial<Task>);
      await manager.startTask(task.id, { project, task, mode: 'start' });
      const run = await nextRun(1);

      expect(run.config.connectorIds).toEqual(['context7']);
      expect(logs).toContain('playwright connector left out of this run: the browser is open\n');
      // Handed to the run, whose own log writer saves it in task_logs.json
      expect(run.config.startNotes).toEqual([{ phase: 'planning', line: 'playwright connector left out of this run: the browser is open' }]);
    } finally {
      connectorMocks.leftOut.clear();
    }
  });

  it('logs a left-out connector under the step the run starts with', async () => {
    const { loadClaudeRunInfo } = await import('../claude-code/task-runner');
    // The last run stopped in validation
    vi.mocked(loadClaudeRunInfo).mockReturnValue({ phases: [{ name: 'validate' }] } as unknown as ReturnType<typeof loadClaudeRunInfo>);
    connectorMocks.leftOut.add('playwright');
    const line = 'playwright connector left out of this run: the browser is open';
    try {
      const task = makeTask({ metadata: { mcpConnectors: ['playwright'] } } as Partial<Task>);
      // A change request begins with coding
      await manager.startTask(task.id, { project, task, mode: 'revise', feedback: 'Fix it' });
      expect((await nextRun(1)).config.startNotes).toEqual([{ phase: 'coding', line }]);

      // So does a resync (its merge is logged under coding)
      pendingResync.value = { ref: 'develop', into: 'develop', via: 'local', merged: [], at: '2026-10-01T00:00:00Z' };
      const other = makeTask({ id: '002-other', specId: '002-other', status: 'human_review', metadata: { mcpConnectors: ['playwright'] } } as Partial<Task>);
      await manager.startTask(other.id, { project, task: other, mode: 'start' });
      expect((await nextRun(2)).config.startNotes).toEqual([{ phase: 'coding', line }]);
      pendingResync.value = undefined;

      // A continued start goes on with validation
      const third = makeTask({ id: '003-third', specId: '003-third', metadata: { mcpConnectors: ['playwright'] } } as Partial<Task>);
      await manager.startTask(third.id, { project, task: third, mode: 'start' });
      expect((await nextRun(3)).config.startNotes).toEqual([{ phase: 'validation', line }]);
    } finally {
      pendingResync.value = undefined;
      connectorMocks.leftOut.clear();
      vi.mocked(loadClaudeRunInfo).mockReturnValue(null);
    }
  });

  describe("the Playwright connector's browser profile", () => {
    const settingsBrowser = { id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Person 1', executablePath: '/chrome', userDataDir: '/c', profilePath: '/c/Default' };
    const taskBrowser = { id: 'firefox:work', browser: 'firefox', engine: 'firefox', profileName: 'work', executablePath: '/firefox', userDataDir: '/f', profilePath: '/f/work' };

    beforeEach(async () => {
      const { readSettingsFile } = await import('../settings-utils');
      vi.mocked(readSettingsFile).mockReturnValue({
        claudeCodeTasks: { triage: 'fixed', fixedModel: 'opus' },
        mcpConnectors: { playwrightEnabled: true, playwrightBrowser: settingsBrowser },
      });
      connectorMocks.runBrowsers.length = 0;
    });

    afterEach(async () => {
      const { readSettingsFile } = await import('../settings-utils');
      vi.mocked(readSettingsFile).mockReturnValue({ claudeCodeTasks: { triage: 'fixed', fixedModel: 'opus' } });
    });

    it('follows Settings > Connectors when the task picked none', async () => {
      const { prepareBrowserProfileCopy } = await import('../browser-profiles/profile-copy');
      const task = makeTask({ metadata: { mcpConnectors: ['playwright'] } } as Partial<Task>);
      await manager.startTask(task.id, { project, task, mode: 'start' });
      const run = await nextRun(1);
      expect(run.config.connectorSettings?.playwrightBrowser).toEqual(settingsBrowser);
      expect(vi.mocked(prepareBrowserProfileCopy).mock.lastCall?.[1]).toEqual(settingsBrowser);
      expect(connectorMocks.runBrowsers).toEqual([undefined]);
    });

    it("uses the task's own browser for the profile copy and the server", async () => {
      const { prepareBrowserProfileCopy } = await import('../browser-profiles/profile-copy');
      const task = makeTask({ metadata: { mcpConnectors: ['playwright'], playwrightBrowser: taskBrowser } } as unknown as Partial<Task>);
      await manager.startTask(task.id, { project, task, mode: 'start' });
      const run = await nextRun(1);
      expect(run.config.connectorSettings?.playwrightBrowser).toEqual(taskBrowser);
      expect(vi.mocked(prepareBrowserProfileCopy).mock.lastCall?.[1]).toEqual(taskBrowser);
      expect(run.config.browserProfileDir).toMatch(/^\/copies\/firefox:work\//);
      // Its sweep keeps the Settings profile's copies
      expect(vi.mocked(prepareBrowserProfileCopy).mock.lastCall?.[3]).toEqual({ project: [settingsBrowser], all: [settingsBrowser] });
      // Availability looks at the task's browser
      expect(connectorMocks.runBrowsers).toEqual([taskBrowser]);
    });

    it("uses Playwright's own Chromium when the task picked it", async () => {
      const { prepareBrowserProfileCopy } = await import('../browser-profiles/profile-copy');
      vi.mocked(prepareBrowserProfileCopy).mockClear();
      const task = makeTask({ metadata: { mcpConnectors: ['playwright'], playwrightBrowser: null } } as unknown as Partial<Task>);
      await manager.startTask(task.id, { project, task, mode: 'start' });
      const run = await nextRun(1);
      expect(run.config.connectorSettings?.playwrightBrowser).toBeUndefined();
      expect(run.config.browserProfileDir).toBeUndefined();
      expect(prepareBrowserProfileCopy).not.toHaveBeenCalled();
      expect(connectorMocks.runBrowsers).toEqual([null]);
    });
  });

  it('runs in the project directory when worktrees are off', async () => {
    const task = makeTask({ metadata: { useWorktree: false } } as Partial<Task>);
    await manager.startTask(task.id, { project, task, mode: 'start' });
    const run = await nextRun(1);
    expect(run.config.worktreePath).toBe('/project');
  });

  it('passes reviewer feedback and its images in revise mode', async () => {
    await manager.startTask('001-add-login', {
      project,
      task: makeTask(),
      mode: 'revise',
      feedback: 'Use the shared button',
      feedbackImagePaths: ['/tmp/shot.jpg'],
    });
    const run = await nextRun(1);
    expect(run.config.mode).toBe('revise');
    expect(run.config.feedback).toBe('Use the shared button');
    expect(run.config.feedbackAttachments).toEqual([{ path: '/tmp/shot.jpg', filename: 'shot.jpg', mimeType: 'image/jpeg' }]);
  });

  it('passes reviewer images on a start over even when nothing was typed', async () => {
    // "Request changes" with "Start over" and only screenshots attached: the images are the notes
    await manager.startTask('001-add-login', {
      project,
      task: makeTask(),
      mode: 'start',
      feedbackImagePaths: ['/tmp/shot.jpg'],
    });
    const run = await nextRun(1);
    expect(run.config.feedback).toBe('');
    expect(run.config.feedbackAttachments).toEqual([{ path: '/tmp/shot.jpg', filename: 'shot.jpg', mimeType: 'image/jpeg' }]);
  });

  /**
   * A task in Human Review whose base branch was merged and deleted - the normal end state of a
   * feature branch used as a base - still has its worktree and its branch, and reviving it cuts
   * nothing from the base branch. Failing it on the missing branch would leave "Request changes"
   * with no way through at all, and the message would ask for a restart, which discards the work.
   */
  it('revises a task whose branch exists even when its base branch resolves nowhere', async () => {
    const { resolveBaseBranch } = await import('../utils/base-branch');
    vi.mocked(resolveBaseBranch).mockRejectedValue(new Error('Base branch "feature/login" does not exist'));
    // `git rev-parse` answers with a sha: the task's branch, and its worktree, are already there
    mockGit.mockResolvedValue({ stdout: '9f1c0de\n', stderr: '' });
    const task = makeTask({ metadata: { baseBranch: 'feature/login' } } as Partial<Task>);

    await manager.startTask(task.id, { project, task, mode: 'revise', feedback: 'Use the shared button' });
    const run = await nextRun(1);

    expect(run.config.mode).toBe('revise');
    expect(resolveBaseBranch).not.toHaveBeenCalled();
    // Named as what the worktree came from, which is what the user chose, and read as nothing else
    expect(run.config.baseBranch).toBe('feature/login');
  });

  it('reports a failed start when the task\'s base branch cannot be resolved', async () => {
    const { resolveBaseBranch } = await import('../utils/base-branch');
    // The message resolving throws is what the user reads, so it has to arrive whole: the
    // branch that is gone and what to do about it
    const thrown = 'Base branch "upstream/main" does not exist locally or on any remote. '
      + 'Give the task a base branch that exists and start it again.';
    vi.mocked(resolveBaseBranch).mockRejectedValueOnce(new Error(thrown));
    const taskEvents: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const errors: string[] = [];
    manager.on('task-event', (_taskId: string, event: Record<string, unknown>) => taskEvents.push(event));
    manager.on('log', (_taskId: string, line: string) => logs.push(line));
    manager.on('error', (_taskId: string, message: string) => errors.push(message));
    manager.on('exit', () => undefined);

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });

    expect(runs).toHaveLength(0);
    expect(taskEvents[0]).toMatchObject({
      type: 'PLANNING_FAILED',
      error: thrown,
      recoverable: true,
    });
    expect(logs.join('')).toContain(`Could not start the task: ${thrown}`);
    expect(errors).toEqual([thrown]);
  });

  it('forwards run callbacks as manager events', async () => {
    const events: Array<[string, unknown[]]> = [];
    for (const name of ['log', 'execution-progress', 'task-event', 'run-info', 'subtasks']) {
      manager.on(name, (...args: unknown[]) => events.push([name, args]));
    }
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    run.callbacks.onLog?.('Reading files');
    run.callbacks.onProgress?.({ phase: 'coding', phaseProgress: 10, overallProgress: 30, message: 'Implementing' });
    run.callbacks.onTaskEvent?.('CODING_STARTED', { subtaskId: '', subtaskDescription: 'Implementing' });
    run.callbacks.onTaskEvent?.('QA_STARTED', { iteration: 1, maxIterations: 1 });
    run.callbacks.onRunInfo?.({ sessionId: 'session-1', phases: [], subagents: [], totalCostUsd: 0, updatedAt: '' });
    run.callbacks.onSubtasks?.([{ id: '1', title: 'Step', description: '', status: 'pending' }]);

    expect(events.find(([n]) => n === 'log')?.[1]).toEqual(['001-add-login', 'Reading files\n', 'project-1']);
    expect(events.find(([n]) => n === 'execution-progress')?.[1][1]).toMatchObject({ phase: 'coding', overallProgress: 30 });
    const taskEvents = events.filter(([n]) => n === 'task-event').map(([, args]) => args[1] as Record<string, unknown>);
    expect(taskEvents.map((e) => e.type)).toEqual(['CODING_STARTED', 'QA_STARTED']);
    expect(taskEvents[0]).toMatchObject({ taskId: '001-add-login', specId: '001-add-login', projectId: 'project-1' });
    expect(taskEvents[1].sequence as number).toBeGreaterThan(taskEvents[0].sequence as number);
    expect(events.some(([n]) => n === 'run-info')).toBe(true);
    expect(manager.getTaskSessionId('001-add-login')).toBe('session-1');
    expect(events.find(([n]) => n === 'subtasks')?.[1][1]).toHaveLength(1);
  });

  it('emits exit 0 when the run completes and exit 1 with an error when it fails', async () => {
    const exits: Array<number | null> = [];
    const errors: string[] = [];
    manager.on('exit', (_taskId: string, code: number | null) => exits.push(code));
    manager.on('error', (_taskId: string, error: string) => errors.push(error));

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(1)).finish({ status: 'completed' });
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(manager.isRunning('001-add-login')).toBe(false);

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(2)).finish({ status: 'failed', error: 'Claude Code stopped with an error' });
    await vi.waitFor(() => expect(exits).toEqual([0, 1]));
    expect(errors).toEqual(['Claude Code stopped with an error']);
  });

  it('emits auth-failure when Claude Code is not signed in', async () => {
    const failures: unknown[] = [];
    manager.on('auth-failure', (_taskId: string, failure: unknown) => failures.push(failure));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(1)).finish({ status: 'auth_failed', error: 'Not signed in' });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ profileId: 'profile-a', message: 'Not signed in' });
  });

  it('stops a run without reporting its outcome', async () => {
    const exits: unknown[] = [];
    manager.on('exit', (...args: unknown[]) => exits.push(args));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    // It reports the project of the run it stopped, which a caller with no project to name needs
    expect(manager.killTask('001-add-login')).toBe('project-1');
    expect(run.stop).toHaveBeenCalled();
    expect(manager.isRunning('001-add-login')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exits).toEqual([]);
  });

  it('keeps the runs of same-named tasks in two projects apart', async () => {
    // Each project numbers its tasks from 001, so the same id turns up in both
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);

    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    const second = await nextRun(2);

    // Starting the second project's task leaves the first project's run alone
    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.isRunning('001-add-login', 'project-1')).toBe(true);
    expect(manager.isRunning('001-add-login', 'project-2')).toBe(true);
    expect(manager.getRunningTasks()).toEqual(['001-add-login', '001-add-login']);

    // And stopping one stops only that project's run
    expect(manager.killTask('001-add-login', 'project-2')).toBe('project-2');
    expect(second.stop).toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.isRunning('001-add-login', 'project-1')).toBe(true);
    expect(manager.isRunning('001-add-login', 'project-2')).toBe(false);
  });

  it('restarts the run of the project it is told, not a same-named task in another', async () => {
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);
    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    const second = await nextRun(2);

    expect(manager.restartTask('001-add-login', 'profile-b', 'project-2')).toBe(true);

    expect(second.stop).toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled();
    const restarted = await nextRun(3);
    expect(restarted.config.projectId).toBe('project-2');
    expect(restarted.config.profileId).toBe('profile-b');
  });

  /**
   * The operation registry keys its operations by the id it is handed, so a bare task id would
   * let the second project's run replace the first's registration - and the first run to end
   * would then unregister whichever entry was left behind.
   */
  it('registers the same task id in two projects as two operations', async () => {
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    await nextRun(1);
    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    await nextRun(2);

    const ids = registry.registerOperation.mock.calls.map((call) => call[0]);
    expect(ids).toEqual(['task:project-1:001-add-login', 'task:project-2:001-add-login']);

    // Both runs are on the same account, and the queue sees two of them rather than one
    expect(manager.getRunningTasksByProfile()).toEqual({
      byProfile: { 'profile-a': ['001-add-login', '001-add-login'] },
      totalRunning: 2,
    });

    // And stopping one takes only its own registration with it
    manager.killTask('001-add-login', 'project-2');
    expect(registry.unregisterOperation.mock.calls).toEqual([['task:project-2:001-add-login']]);
    expect(manager.getRunningTasksByProfile().totalRunning).toBe(1);
  });

  /**
   * Callers that still name no project (the stop button among them) have to keep working, but
   * with the same task id in two projects there is no run they can be meaning: stopping one at
   * random would kill work the user never touched, so the manager refuses and says so.
   */
  it('refuses to stop a task by id alone while two projects are running it', async () => {
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);
    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    const second = await nextRun(2);

    expect(manager.killTask('001-add-login')).toBeUndefined();
    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
    expect(manager.isRunning('001-add-login', 'project-1')).toBe(true);
    expect(manager.isRunning('001-add-login', 'project-2')).toBe(true);

    // The one run left over is found by its task id again, so the tolerant path still works
    expect(manager.killTask('001-add-login', 'project-2')).toBe('project-2');
    // It reports the project of the run it stopped, which a caller with no project to name needs
    expect(manager.killTask('001-add-login')).toBe('project-1');
    expect(first.stop).toHaveBeenCalled();
  });

  it('restarts the right project\'s run when the swap comes through the operation registry', async () => {
    // A rate limit swaps the run through the callback registered with the operation registry, and
    // that callback has to name its project: with the same 001 running in two projects, the task
    // id alone would let the swap stop and restart the other project's run
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);
    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    const second = await nextRun(2);

    // The registration of the second project's run, told apart by the project path it carries
    const registration = registry.registerOperation.mock.calls.find(
      (call) => (call[5] as { metadata?: { projectPath?: string } } | undefined)?.metadata?.projectPath === '/other'
    );
    const swap = registration?.[4] as (profileId: string) => boolean;
    expect(swap('profile-b')).toBe(true);

    expect(second.stop).toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled();
    const restarted = await nextRun(3);
    expect(restarted.config.projectId).toBe('project-2');
    expect(restarted.config.profileId).toBe('profile-b');
  });

  it('records a rate limit on the profile the run used and tags the event with it', async () => {
    const taskEvents: Array<Record<string, unknown>> = [];
    manager.on('task-event', (_taskId: string, event: Record<string, unknown>) => taskEvents.push(event));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    run.callbacks.onTaskEvent?.('RATE_LIMIT_HOLD', {
      resetAt: '2026-10-10T18:30:00.000Z',
      message: "You've hit your session limit · resets 8:30pm (Asia/Yerevan)",
      phase: 'coding',
    });

    expect(profileManager.recordRateLimitEvent).toHaveBeenCalledWith('profile-a', '8:30pm (Asia/Yerevan)');
    expect(taskEvents[0]).toMatchObject({ type: 'RATE_LIMIT_HOLD', profileId: 'profile-a', phase: 'coding' });
  });

  it('restarts a run on another profile once the previous run settled', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);

    expect(manager.restartTask('001-add-login', 'profile-b')).toBe(true);
    expect(first.stop).toHaveBeenCalled();
    expect(profileManager.setActiveProfile).toHaveBeenCalledWith('profile-b');

    const second = await nextRun(2);
    expect(second.config.profileId).toBe('profile-b');
    expect(manager.isRunning('001-add-login')).toBe(true);
  });

  it('gives up restarting after repeated swaps', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    await nextRun(1);
    expect(manager.restartTask('001-add-login', 'profile-b')).toBe(true);
    await nextRun(2);
    expect(manager.restartTask('001-add-login', 'profile-c')).toBe(true);
    await nextRun(3);
    expect(manager.restartTask('001-add-login', 'profile-d')).toBe(false);
  });

  it('reports a failed start when the worktree cannot be created', async () => {
    const { createOrGetWorktree } = await import('../worktree');
    vi.mocked(createOrGetWorktree).mockRejectedValueOnce(new Error('git worktree add failed'));
    const taskEvents: Array<Record<string, unknown>> = [];
    const exits: Array<number | null> = [];
    manager.on('task-event', (_taskId: string, event: Record<string, unknown>) => taskEvents.push(event));
    manager.on('exit', (_taskId: string, code: number | null) => exits.push(code));
    manager.on('error', () => undefined);

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });

    expect(runs).toHaveLength(0);
    expect(taskEvents[0]).toMatchObject({ type: 'PLANNING_FAILED', error: 'git worktree add failed' });
    expect(exits).toEqual([1]);
    expect(manager.isRunning('001-add-login')).toBe(false);
  });
});
