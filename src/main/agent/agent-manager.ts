import { EventEmitter } from 'events';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentState } from './agent-state';
import type { ExecutionProgressData, StartTaskOptions } from './types';
import type { TaskEventPayload } from './task-event-schema';
import {
  ClaudeTaskRun,
  type TaskAttachment,
  type TaskRunConfig,
  type TaskRunOutcome,
} from '../claude-code/task-runner';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { isClaudeRunFinished, loadClaudeRunInfo, resetClaudeRunInfo } from '../claude-code/task-runner';
import { detectClaudeLimitMessage } from '../claude-code/limit';
import { createOrGetWorktree } from '../worktree';
import { addToWorktree } from '../live-agent/project-setup';
import { describeLeftOutConnector, usableMcpConnectorIds } from '../mcp-availability';
import { TaskLogWriter } from '../claude-code/task-log';
import type { TaskLogPhase } from '../../shared/types/task';
import { prepareBrowserProfileCopy, removeBrowserProfileCopy, removeStaleBrowserProfileCopies } from '../browser-profiles/profile-copy';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import { readSettingsFile, readSettingsFileAsync } from '../settings-utils';
import { getGraphifyPromptContext, isGraphifyEnabled } from '../graphify';
import { isSelfImproveEnabled, SELF_IMPROVE_NUDGE } from '../self-improve';
import { getAugmentedEnvAsync } from '../env-utils';
import { isWslRuntime } from '../platform/shell-runtime';
import { git } from '../utils/git-exec';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { getOperationRegistry } from '../claude-profile/operation-registry';
import { getAPIProfileEnv } from '../services/profile';
import { getSpecsDir } from '../../shared/constants';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import type { AppSettings } from '../../shared/types/settings';
import { appLog } from '../app-logger';
import { resolveBaseBranch, resolveDefaultBaseBranch } from '../utils/base-branch';
import { taskHooks } from '../task-hooks';
import { getTaskChangelogPath } from '../task-changelog';
import { createRunMessaging } from '../task-messaging/run-messaging';
import { branchMergeBlocker, waitForBranchSync } from '../worktree/merge-guard';
import { keepsLocalMergeOut, readResyncRequest } from '../task-resync/request';


/** Restarts after a rate limit or auth problem before giving up (prevents swap loops) */
const MAX_SWAPS_PER_TASK = 2;
/** How long killAll waits for runs to wind down */
const KILL_ALL_TIMEOUT_MS = 10_000;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

interface RunEntry {
  options: StartTaskOptions;
  projectId: string;
  taskId: string;
  /** Set once setup finished and the run was created */
  run?: ClaudeTaskRun;
  /** Claude profile the run was started on (undefined: best available at start) */
  profileId?: string;
  /** An API profile (Anthropic-compatible endpoint) is active: Claude profiles are not used */
  apiProfileActive: boolean;
  /** Stopped by killTask/restartTask: its outcome is not reported */
  killed: boolean;
  /** Settles when the run (and its state flush) finished */
  done: Promise<void>;
}

/**
 * AgentManager: runs tasks through the Claude Code CLI (ClaudeTaskRun) and turns the run's
 * callbacks into events for the IPC layer:
 *
 *   log, error, execution-progress, task-event (XState TaskEventPayload), run-info
 *   (claude_run.json), subtasks (Claude Code's task list), auth-failure, run-finished, exit
 */
/**
 * Runs are held per project and task: a task id is its spec id (`001-<slug>`), which each
 * project numbers from its own start, so two projects can hold the same one. Keying by the
 * task alone would let starting a task in one project stop a same-named run in another.
 */
const runKey = (projectId: string, taskId: string): string => `${projectId}\u0000${taskId}`;

/**
 * The id a run is registered under in the operation registry (account swaps). The registry keys
 * its operations by whatever id it is handed, so a bare task id would let the second project's
 * run overwrite the first's registration, and the first run to finish would unregister whichever
 * entry was left - leaving one run without a swap registration and the other with a stale one
 * pointing at a run that has ended. The registry and its other reader (`usage-monitor.ts`, which
 * groups ids by profile and logs them) treat the id as opaque, so naming the project here is
 * free; it is spelled out rather than reusing `runKey` because it is read by people in logs.
 */
const operationId = (projectId: string, taskId: string): string => `task:${projectId}:${taskId}`;

export class AgentManager extends EventEmitter {
  private state = new AgentState();
  private runs = new Map<string, RunEntry>();
  /** Options of the latest run per project and task, for restarts after it ended */
  private lastOptions = new Map<string, StartTaskOptions>();
  /** Automatic restarts (profile swaps) per project and task since the user last started it */
  private swapCounts = new Map<string, number>();
  /** Last task event sequence per project and task (monotonic across runs and app restarts) */
  private sequences = new Map<string, number>();

  /**
   * The key a task's run is held under. Callers that know the project get exactly it;
   * the rest take the one run with that task id.
   *
   * Everything the user does to a run now names its project: the board sends the project the card
   * belongs to, and the handlers pass that through rather than working one out. The bare task id
   * still has to answer, though, for callers that genuinely have none - the Insights task tools, a
   * renderer older than the field it now sends - and for internal callers that never had one.
   *
   * With two projects running the same task id there is no run such a caller can be meaning, and
   * the arbitrary first match would stop or restart a run the user never touched, so that case is
   * logged and refused: the caller reads it as "not running", which the user can repeat from the
   * project's own board, where the project travels with the request.
   */
  private keyOf(taskId: string, projectId?: string): string | undefined {
    if (projectId) {
      const key = runKey(projectId, taskId);
      return this.runs.has(key) || this.lastOptions.has(key) ? key : undefined;
    }
    let found: string | undefined;
    for (const [key, entry] of this.runs) {
      if (entry.taskId !== taskId) continue;
      if (found !== undefined) {
        appLog.warn(
          `[AgentManager] ${taskId} is running in more than one project and no project was named, doing nothing`
        );
        return undefined;
      }
      found = key;
    }
    return found;
  }

  // ============================================
  // Task lifecycle
  // ============================================

  /**
   * Start (or continue) a task, or apply reviewer feedback (`mode: 'revise'`).
   * Run state lives in `<specDir>/claude_run.json`, so a started task continues where it
   * stopped (triage, plan and implementation aren't repeated once completed).
   */
  async startTask(taskId: string, options: StartTaskOptions): Promise<void> {
    return this.launch(taskId, options, false);
  }

  private async launch(taskId: string, startOptions: StartTaskOptions, isRestart: boolean): Promise<void> {
    // The project's Claude account (Settings > Project) unless the run is pinned to another one
    // (e.g. a restart after an account swap); none: the account in use
    const options: StartTaskOptions = {
      ...startOptions,
      profileId: startOptions.profileId ?? startOptions.project.settings?.claudeProfileId,
    };
    const { project } = options;
    const projectId = project.id;
    const key = runKey(projectId, taskId);

    // Only one run per task, in this project: a task of the same name in another project
    // keeps its own run
    const previous = this.runs.get(key);
    if (previous) {
      this.killTask(taskId, projectId);
      await previous.done;
    }
    if (!isRestart) this.swapCounts.delete(key);
    this.lastOptions.set(key, options);

    let resolveDone!: () => void;
    const entry: RunEntry = {
      options,
      projectId,
      taskId,
      profileId: options.profileId,
      apiProfileActive: false,
      killed: false,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
    };
    this.runs.set(key, entry);
    this.state.addRunning(taskId, projectId);

    let config: TaskRunConfig;
    try {
      // Never on a branch that is being merged (the start handlers refuse first; this covers the rest)
      const blocker = branchMergeBlocker(projectId, taskId);
      if (blocker) throw new Error(blocker);
      // The run counts as running from here, so no new pull starts; one already merging another
      // task's changes into the worktree ends first
      await waitForBranchSync(projectId, taskId);
      config = await this.buildRunConfig(taskId, options);
      entry.apiProfileActive = await this.isApiProfileActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog.error(`[AgentManager] Could not start task ${taskId}:`, message);
      if (this.runs.get(key) === entry) {
        this.runs.delete(key);
        this.state.removeRunning(taskId, projectId);
      }
      resolveDone();
      if (entry.killed) return;
      this.emit('log', taskId, `Could not start the task: ${message}\n`, projectId);
      this.emitTaskEvent(taskId, options, 'PLANNING_FAILED', { error: message, recoverable: true });
      this.emitError(taskId, message, projectId);
      this.emit('exit', taskId, 1, 'task-execution', projectId);
      return;
    }

    // Stopped while the worktree was being prepared
    if (entry.killed) {
      config.messaging?.dispose();
      if (config.browserProfileDir) await removeBrowserProfileCopy(config.browserProfileDir);
      resolveDone();
      return;
    }

    const run = new ClaudeTaskRun(config, {
      onLog: (line) => {
        if (!entry.killed) this.emit('log', taskId, line.endsWith('\n') ? line : `${line}\n`, projectId);
      },
      onProgress: (progress) => {
        if (entry.killed) return;
        const data: ExecutionProgressData = {
          phase: progress.phase,
          phaseProgress: progress.phaseProgress,
          overallProgress: progress.overallProgress,
          message: progress.message,
          ...(progress.currentSubtask ? { currentSubtask: progress.currentSubtask } : {}),
          // Always set, so the card's "Syncing with" label goes away with the next step
          syncingWith: progress.syncingWith ?? null,
        };
        this.emit('execution-progress', taskId, data, projectId);
      },
      onTaskEvent: (type, payload) => {
        if (entry.killed) return;
        const extra: Record<string, unknown> = { ...payload };
        if (type === 'RATE_LIMIT_HOLD') {
          const profileId = this.recordRateLimit(entry, payload);
          if (profileId) extra.profileId = profileId;
        }
        this.emitTaskEvent(taskId, options, type, extra);
      },
      onRunInfo: (info) => {
        if (entry.killed) return;
        if (info.sessionId) this.state.updateTaskSession(taskId, info.sessionId, undefined, projectId);
        this.emit('run-info', taskId, info, projectId);
      },
      onSubtasks: (subtasks) => {
        if (!entry.killed) this.emit('subtasks', taskId, subtasks, projectId);
      },
      onFilesEdited: (files) => {
        if (!entry.killed) taskHooks.emit('files-edited', { project: options.project, task: options.task, files });
      },
    });
    entry.run = run;

    this.registerWithOperationRegistry(taskId, entry);

    run.run()
      .then((outcome) => this.handleRunFinished(taskId, entry, outcome))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.handleRunFinished(taskId, entry, { status: 'failed', error: message });
      })
      .finally(async () => {
        // The run's Workbench tools stop working with it
        config.messaging?.dispose();
        // Removed before a restart of the task copies the profile again
        if (config.browserProfileDir) await removeBrowserProfileCopy(config.browserProfileDir);
        resolveDone();
      });
  }

  /**
   * Stop a task's run. Its outcome is not reported (callers send USER_STOPPED themselves).
   *
   * Returns the project of the run it stopped, or undefined when there was none to stop. A caller
   * that had no project to name - and so let the bare task id find the single run carrying it -
   * needs that answer to go on to the right project's task: looking it up from the task id again
   * would pick the first project holding the id, which is not necessarily the one just stopped.
   */
  killTask(taskId: string, projectId?: string): string | undefined {
    const key = this.keyOf(taskId, projectId);
    const entry = key ? this.runs.get(key) : undefined;
    if (!key || !entry) return undefined;
    entry.killed = true;
    entry.run?.stop();
    this.runs.delete(key);
    // The run the key found owns the project, which the caller may not have named
    this.state.removeRunning(taskId, entry.projectId);
    getOperationRegistry().unregisterOperation(operationId(entry.projectId, taskId));
    return entry.projectId;
  }

  /** Stop all runs and wait (bounded) for them to wind down */
  async killAll(): Promise<void> {
    const pending = Array.from(this.runs.values()).map((entry) => {
      this.killTask(entry.taskId, entry.projectId);
      return entry.done;
    });
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => setTimeout(resolve, KILL_ALL_TIMEOUT_MS)),
    ]);
  }

  /** Check if a task is running */
  isRunning(taskId: string, projectId?: string): boolean {
    const key = this.keyOf(taskId, projectId);
    return key !== undefined && this.runs.has(key);
  }

  /** Session of a running task's Claude Code run (undefined until the run started) */
  getRunSession(taskId: string, projectId?: string): { sessionId?: string; profileId?: string; configDir?: string } | undefined {
    const key = this.keyOf(taskId, projectId);
    return key ? this.runs.get(key)?.run?.session : undefined;
  }

  /** All running task IDs */
  getRunningTasks(): string[] {
    return Array.from(this.runs.values()).map((entry) => entry.taskId);
  }

  /**
   * Restart a task's run on another Claude profile (rate limit or proactive swap). The run
   * continues from its saved state. Returns false when the task can't be restarted.
   */
  restartTask(taskId: string, newProfileId?: string, projectId?: string): boolean {
    const key = this.keyOf(taskId, projectId);
    const options = (key ? this.runs.get(key)?.options ?? this.lastOptions.get(key) : undefined);
    if (!key || !options) {
      appLog.warn(`[AgentManager] restartTask: no run options for ${taskId}`);
      return false;
    }
    const swaps = this.swapCounts.get(key) ?? 0;
    if (swaps >= MAX_SWAPS_PER_TASK) {
      appLog.warn(`[AgentManager] restartTask: ${taskId} already restarted ${swaps} times, not restarting again`);
      return false;
    }
    this.swapCounts.set(key, swaps + 1);

    if (newProfileId) {
      const profileManager = getClaudeProfileManager();
      if (profileManager.getActiveProfile()?.id !== newProfileId) {
        profileManager.setActiveProfile(newProfileId);
      }
    }

    const previous = this.runs.get(key);
    this.killTask(taskId, options.project.id);
    const restartOptions: StartTaskOptions = { ...options, profileId: newProfileId ?? options.profileId };
    void (previous?.done ?? Promise.resolve()).then(() =>
      this.launch(taskId, restartOptions, true).catch((error) =>
        appLog.error(`[AgentManager] Restarting ${taskId} failed:`, error)
      )
    );
    return true;
  }

  // ============================================
  // Queue Routing Methods (Rate Limit Recovery)
  // ============================================

  /** Running tasks grouped by profile (queue routing) */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    return this.state.getRunningTasksByProfile();
  }

  /**
   * Record which profile a task uses.
   *
   * The project is optional here, as it is on the lookups below, only because a task id alone is
   * what the callers outside this file have: naming it is what keeps two projects' same-named
   * tasks apart, so everything inside this file passes it.
   */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual',
    projectId?: string
  ): void {
    this.state.assignProfileToTask(taskId, profileId, profileName, reason, projectId);
  }

  /** Profile assignment of a task */
  getTaskProfileAssignment(
    taskId: string,
    projectId?: string
  ): { profileId: string; profileName: string; reason: string } | undefined {
    return this.state.getTaskProfileAssignment(taskId, projectId);
  }

  /** Update the Claude Code session ID of a task */
  updateTaskSession(taskId: string, sessionId: string, projectId?: string): void {
    this.state.updateTaskSession(taskId, sessionId, undefined, projectId);
  }

  /** Claude Code session ID of a task */
  getTaskSessionId(taskId: string, projectId?: string): string | undefined {
    return this.state.getTaskSessionId(taskId, projectId);
  }

  // ============================================
  // Internals
  // ============================================

  private async buildRunConfig(taskId: string, options: StartTaskOptions): Promise<TaskRunConfig> {
    const { project, task, mode } = options;
    const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);

    // A base branch the user chose - on the task, or as the project's main branch - may have been
    // deleted or renamed since. Nothing stands in for it: this throws, `launch()` turns the message
    // into a recoverable failure, and the user gives the task a base branch that exists instead of
    // getting a run built on code they never chose. A branch the repository has never heard of is
    // not the same thing as a branch that is gone - a teammate may have pushed it, or it may have
    // been typed in by hand - so resolving fetches it once before it calls it missing. With
    // nothing chosen there is no choice to honour, so the repository is asked what its default
    // branch is rather than assuming `main`, which would fail on every project whose default is
    // `master`
    const chosenBaseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

    // That strictness is about the one moment the base branch decides what the work is built on:
    // the task's branch being cut from it. It happens once per task - `createOrGetWorktree` only
    // looks the base branch up when `workbench/<specId>` does not exist yet, and otherwise attaches
    // the worktree to that branch and never reads the base at all (its steps 4 and 6) - and a task
    // that runs in the project itself never branches from anything. Failing every mode on a missing
    // base branch therefore stranded exactly the tasks that need it least: a finished task in Human
    // Review whose base branch had since been merged and deleted could not be revised or continued,
    // and the message asked for a restart, which throws the finished work away.
    const branchingFromBase =
      task.metadata?.useWorktree !== false
      && !(await this.localBranchExists(project.path, getTaskWorktreeBranch(task.specId)));

    // With nothing branched from it, the base branch is only ever read as text: the system prompt
    // names it as what the worktree was cut from and the validation step diffs against it. The
    // branch the user chose is the honest answer there - it is what this worktree really came from -
    // and when it is gone that diff fails in the agent's own shell, where it can say so, which beats
    // naming some other branch the work was never based on. Nothing else reads this value: the
    // parallel-tasks changelog goes to the task's own metadata for its base branch
    // (`task-changelog-writer.ts`), not here.
    //
    // A task with no base branch chosen asks the repository for its default, which substitutes for
    // no choice of the user's rather than for a choice. That answer is required only when a branch
    // is about to be cut from it; a run that needs no worktree can live in a directory that is not
    // a git repository at all, or in one freshly `git init`ed with no commit, and there the
    // detection has nothing to answer with. Failing to start over a value that is only going to be
    // printed would make those runs impossible, so the name stands in as a label instead.
    const baseBranch = chosenBaseBranch
      ? (branchingFromBase ? await resolveBaseBranch(project.path, chosenBaseBranch) : chosenBaseBranch)
      : await this.detectBaseBranch(project.path, branchingFromBase);

    let worktreePath: string;
    let branch: string;
    if (task.metadata?.useWorktree === false) {
      worktreePath = project.path;
      branch = await this.getCurrentBranch(project.path) ?? baseBranch;
    } else {
      const worktree = await createOrGetWorktree(
        project.path,
        task.specId,
        baseBranch,
        task.metadata?.useLocalBranch ?? false,
        task.metadata?.pushNewBranches ?? project.settings?.pushNewBranches !== false,
        project.autoBuildPath,
      );
      worktreePath = worktree.worktreePath;
      branch = worktree.branch;
      // Live agent: the project's Claude Code hooks (settings.local.json isn't checked out)
      try {
        addToWorktree(project.path, worktreePath);
      } catch (error) {
        appLog.warn('[AgentManager] Could not copy the Live agent hooks to the worktree:', error);
      }
    }

    const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
    const attachments: TaskAttachment[] = (task.metadata?.attachedImages ?? [])
      .filter((image) => !!image.path)
      .map((image) => {
        const absolute = path.isAbsolute(image.path!) ? image.path! : path.join(specDir, image.path!);
        return {
          path: absolute,
          filename: image.filename || path.basename(absolute),
          mimeType: image.mimeType || mimeTypeFor(absolute),
        };
      });
    const feedbackAttachments: TaskAttachment[] = (options.feedbackImagePaths ?? []).map((imagePath) => ({
      path: imagePath,
      filename: path.basename(imagePath),
      mimeType: mimeTypeFor(imagePath),
    }));

    const taskSettings = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks);
    // Another task was merged into the base branch since this one ran: whatever starts the run (the
    // resync service, the queue, a rate-limit resume, the user) takes it in first (task-resync/).
    // Not a local merge into a task with a pull request: its next push would carry those commits
    const pendingResync = task.metadata?.useWorktree !== false ? readResyncRequest(specDir) : undefined;
    const resync = pendingResync && !keepsLocalMergeOut(pendingResync, task) ? pendingResync : undefined;
    // Starting a task whose last run went all the way through begins a new run (fresh triage
    // and session) in the same worktree, instead of finishing again immediately. Not for a resync:
    // the session that did the work merges the base branch in and resumes
    if (mode === 'start' && !resync && isClaudeRunFinished(loadClaudeRunInfo(specDir), taskSettings.validation)) {
      resetClaudeRunInfo(specDir);
    }

    const config: TaskRunConfig = {
      taskId,
      projectId: project.id,
      specId: task.specId,
      specDir,
      worktreePath,
      isolated: task.metadata?.useWorktree !== false,
      branch,
      baseBranch,
      title: task.title || task.specId,
      description: task.description?.trim() || task.title || task.specId,
      attachments,
      // The task's connectors (or the defaults), without servers that can't start
      connectorIds: await usableMcpConnectorIds(
        Array.isArray(task.metadata?.mcpConnectors) ? task.metadata.mcpConnectors : getDefaultMcpConnectorIds(settings.mcpConnectors),
        settings.mcpConnectors,
        (id, availability) => this.noteLeftOutConnector(taskId, options, specDir, describeLeftOutConnector(id, availability, settings.mcpConnectors))
      ),
      connectorSettings: settings.mcpConnectors,
      settings: taskSettings,
      // Read again at each step, so switching Task messaging or messages from sessions off reaches a running task
      readCurrentSettings: async () => resolveClaudeCodeTaskSettings(
        ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.claudeCodeTasks),
      maxBudgetUsd: project.settings?.maxBudgetUsd,
      changelogPath: project.autoBuildPath ? getTaskChangelogPath(project.path, project.autoBuildPath) : undefined,
      mode,
      // revise: the change to apply. start: what a discarded attempt got wrong, when the
      // reviewer asked for the task to be started over. Reviewer notes can be screenshots with
      // nothing typed, so the images alone are enough to carry over
      ...(mode === 'revise' || options.feedback || feedbackAttachments.length > 0
        ? { feedback: options.feedback ?? '', feedbackAttachments }
        : {}),
      profileId: options.profileId,
      ...(resync ? { resync } : {}),
    };

    if (isSelfImproveEnabled(project.settings)) config.selfImprovePrompt = SELF_IMPROVE_NUDGE;
    // The Puppeteer connector's browser profile: a fresh copy per run (sign-ins as they are now),
    // in the run's own slot so no two runs share a profile folder
    const browser = settings.mcpConnectors?.puppeteerBrowser;
    if (browser && config.connectorIds?.includes('puppeteer')) {
      try {
        // A slot per run: a stopped run of the task may still be cleaning up its own copy
        const slot = `task-${task.specId}-${randomUUID().slice(0, 8)}`;
        config.browserProfileDir = (await prepareBrowserProfileCopy(project.path, browser, slot)) ?? undefined;
        // Copies earlier runs of the task left behind (a crash); not awaited, the run doesn't need it.
        // Live runs' copies are kept, such as a newer launch's after this one was stopped mid-copy
        void removeStaleBrowserProfileCopies(project.path, browser, `task-${task.specId}-`, slot);
      } catch (error) {
        appLog.warn(`[AgentManager] Could not copy the browser profile for ${taskId}:`, error);
      }
    }
    // Parallel tasks message each other through Workbench (Settings > Agents)
    if (taskSettings.taskMessaging) config.messaging = createRunMessaging(project.id, task.specId);

    if (await isGraphifyEnabled(project.path)) {
      try {
        const graphify = await getGraphifyPromptContext(project.path);
        if (graphify) {
          config.graphifyPrompt = graphify.commandPrompt;
          // GRAPHIFY_OUT is a host path (translated when the run starts in WSL). In WSL graphify
          // comes from the distribution's login PATH, so no Windows PATH entry is added
          config.extraEnv = { GRAPHIFY_OUT: path.dirname(graphify.graph) };
          if (!isWslRuntime()) {
            const augmented = await getAugmentedEnvAsync([path.dirname(graphify.cli)]);
            if (augmented.PATH) config.extraEnv.PATH = augmented.PATH;
          }
        }
      } catch (error) {
        appLog.warn(`[AgentManager] Graphify context unavailable for ${taskId}:`, error);
      }
    }

    return config;
  }

  /**
   * The repository's default branch, for a task that named none.
   *
   * `required` is false when nothing will be branched from it, and then a repository that cannot
   * name a default - no git, or no commit yet - gives up the name `main` as a label rather than
   * failing the run. It is never a start point in that case, so no work can be built on the wrong
   * branch by it.
   */
  private async detectBaseBranch(projectPath: string, required: boolean): Promise<string> {
    if (required) return resolveDefaultBaseBranch(projectPath);
    try {
      return await resolveDefaultBaseBranch(projectPath);
    } catch (error) {
      appLog.info(`[AgentManager] ${projectPath} names no default branch, using "main" as the label: ${String(error)}`);
      return 'main';
    }
  }

  /**
   * Whether the repository already has the task's own branch, which is what decides whether a run
   * is about to cut that branch from the base branch.
   *
   * A git call that fails answers no, so the strict base-branch resolution still runs: it exists to
   * catch a missing base before `git worktree add` does, and skipping it because git hiccuped would
   * move that failure to where the user only sees git's own words.
   */
  private async localBranchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      const { stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async getCurrentBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      const branch = stdout.trim();
      return branch && branch !== 'HEAD' ? branch : null;
    } catch {
      return null;
    }
  }

  private async isApiProfileActive(): Promise<boolean> {
    try {
      return Object.keys(await getAPIProfileEnv()).length > 0;
    } catch {
      return false;
    }
  }

  /** Next task event sequence: increases per task, also across runs and app restarts */
  private nextSequence(taskId: string, projectId: string): number {
    const key = runKey(projectId, taskId);
    const next = Math.max((this.sequences.get(key) ?? 0) + 1, Date.now());
    this.sequences.set(key, next);
    return next;
  }

  /**
   * A connector the task chose was left out of this run (its browser is open, its server can't
   * start): said in the task's log, live and in task_logs.json. Written before the run's own log
   * writer loads the file, so the run keeps the entry
   */
  private noteLeftOutConnector(taskId: string, options: StartTaskOptions, specDir: string, line: string): void {
    this.emit('log', taskId, `${line}\n`, options.project.id);
    try {
      const last = loadClaudeRunInfo(specDir)?.phases.at(-1)?.name;
      // The step the run continues with
      const phase: TaskLogPhase = last === 'validate' ? 'validation'
        : options.mode === 'revise' || last === 'implement' || last === 'revise' || last === 'resync' ? 'coding' : 'planning';
      const log = new TaskLogWriter(specDir, options.task.specId);
      log.add(phase, 'info', line);
      log.saveNow();
    } catch (error) {
      appLog.warn(`[AgentManager] Could not log a left-out connector for ${taskId}:`, error);
    }
  }

  private emitTaskEvent(taskId: string, options: StartTaskOptions, type: string, payload: Record<string, unknown>): void {
    const event: TaskEventPayload = {
      ...payload,
      type,
      taskId,
      specId: options.task.specId,
      projectId: options.project.id,
      timestamp: new Date().toISOString(),
      eventId: randomUUID(),
      sequence: this.nextSequence(taskId, options.project.id),
    };
    this.emit('task-event', taskId, event, options.project.id);
  }

  /**
   * Record a rate limit on the Claude profile the run used, so the next runs (and an
   * automatic swap) pick another profile. Returns that profile's ID.
   */
  private recordRateLimit(entry: RunEntry, payload: Record<string, unknown>): string | undefined {
    if (entry.apiProfileActive) return undefined;
    try {
      const profileManager = getClaudeProfileManager();
      const profileId = entry.profileId ?? profileManager.getActiveProfile()?.id;
      if (!profileId) return undefined;
      const message = typeof payload.message === 'string' ? payload.message : '';
      const resetText = detectClaudeLimitMessage(message)?.resetText;
      const resetAt = typeof payload.resetAt === 'string' ? new Date(payload.resetAt) : null;
      if (resetText) {
        profileManager.recordRateLimitEvent(profileId, resetText);
      } else if (resetAt && !Number.isNaN(resetAt.getTime())) {
        // Only the reset instant is known: record it as is (a formatted date would read as a
        // weekly limit)
        profileManager.recordRateLimitEvent(profileId, '', { resetAt });
      }
      return profileId;
    } catch (error) {
      appLog.warn('[AgentManager] Could not record the rate limit:', error);
      return undefined;
    }
  }

  private registerWithOperationRegistry(taskId: string, entry: RunEntry): void {
    if (entry.apiProfileActive) return;
    try {
      const profileManager = getClaudeProfileManager();
      const profile = entry.profileId ? profileManager.getProfile(entry.profileId) : profileManager.getActiveProfile();
      if (!profile) return;
      this.state.assignProfileToTask(
        taskId,
        profile.id,
        profile.name,
        entry.profileId ? 'reactive' : 'proactive',
        entry.projectId
      );
      // No stopFn: restartTask stops the run itself. Both the id the run is registered under and
      // the swap name the project as well as the task, because a task id only tells the projects
      // apart together with it: left out, the second project's run would replace the first's
      // registration, and restartTask would take whichever run happens to carry that id, so a
      // rate-limit swap here could stop and restart another project's run instead of this one
      getOperationRegistry().registerOperation(
        operationId(entry.projectId, taskId),
        'task-execution',
        profile.id,
        profile.name,
        (newProfileId: string) => this.restartTask(taskId, newProfileId, entry.projectId),
        { metadata: { projectPath: entry.options.project.path, specId: entry.options.task.specId } }
      );
    } catch (error) {
      appLog.warn('[AgentManager] Could not register the task for profile swaps:', error);
    }
  }

  /** 'error' without a listener would throw (EventEmitter semantics) */
  private emitError(taskId: string, message: string, projectId?: string): void {
    if (this.listenerCount('error') > 0) this.emit('error', taskId, message, projectId);
  }

  private handleRunFinished(taskId: string, entry: RunEntry, outcome: TaskRunOutcome): void {
    const key = runKey(entry.projectId, taskId);
    if (this.runs.get(key) === entry) {
      this.runs.delete(key);
      this.state.removeRunning(taskId, entry.projectId);
      getOperationRegistry().unregisterOperation(operationId(entry.projectId, taskId));
    }
    // Stopped by the user or replaced by a restart: nothing to report
    if (entry.killed || outcome.status === 'stopped') return;

    const { projectId } = entry;
    this.emit('run-finished', taskId, outcome, projectId);

    if (outcome.status === 'auth_failed') {
      this.emit('auth-failure', taskId, {
        profileId: entry.apiProfileActive ? undefined : entry.profileId ?? getActiveProfileIdSafe(),
        failureType: 'invalid',
        message: outcome.error,
      });
    }
    if (outcome.status === 'failed' || outcome.status === 'auth_failed') {
      const message = outcome.error ?? 'The task failed';
      this.emit('execution-progress', taskId, {
        phase: 'failed',
        phaseProgress: 0,
        overallProgress: 0,
        message,
      } satisfies ExecutionProgressData, projectId);
      this.emitError(taskId, message, projectId);
    }

    this.emit('exit', taskId, outcome.status === 'completed' ? 0 : 1, 'task-execution', projectId);
  }
}

function mimeTypeFor(filePath: string): string {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

function getActiveProfileIdSafe(): string | undefined {
  try {
    return getClaudeProfileManager().getActiveProfile()?.id;
  } catch {
    return undefined;
  }
}

