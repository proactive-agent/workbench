import type { BrowserWindow } from "electron";
import path from "path";
import { existsSync } from "fs";
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from "../../shared/constants";
import type {
  SDKRateLimitInfo,
  AuthFailureInfo,
  ImplementationPlan,
} from "../../shared/types";
import type { ClaudeRunInfo } from "../../shared/types/claude-code";
import { XSTATE_SETTLED_STATES, XSTATE_ACTIVE_STATES, XSTATE_TO_PHASE, mapStateToLegacy } from "../../shared/state-machines";
import { AgentManager } from "../agent";
import type { ProcessType, ExecutionProgressData, AgentAuthFailure } from "../agent";
import type { TaskRunSubtask } from "../claude-code/task-runner";
import { titleGenerator } from "../title-generator";
import { fileWatcher } from "../file-watcher";
import { notificationService } from "../notification-service";
import { persistPlanLastEventSync, getPlanPath, persistPlanPhaseSync, persistPlanStatusAndReasonSync, hasStartedImplementation, writePlanSubtasksSync } from "./task/plan-file-utils";
import { findTaskWorktree } from "../worktree-paths";
import { findTaskAndProject } from "./task/shared";
import { safeSendToRenderer } from "./utils";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { taskStateManager } from "../task-state-manager";
import { parseRateLimitHold } from "../../shared/utils/rate-limit-hold";
import { applyRateLimitHold } from "./task/rate-limit-hold";
import { isGraphifyEnabled, refreshGraphifyIndex } from "../graphify";
import { projectStore } from "../project-store";
import { appLog } from "../app-logger";
import { registerTaskChangelog } from "../task-changelog-writer";
import { registerTaskMessaging } from "../task-messaging";

// Timeout for fallback safety net to check if task is still stuck after process exit
const STUCK_TASK_FALLBACK_TIMEOUT_MS = 500;

/**
 * The pending fallback timers, by project and task — the same keying `AgentState` and
 * `TaskStateManager` use, and for the same reason: a task id is only unique inside its project.
 * Keyed by the task alone, one project starting the task cancelled another project's net, so that
 * project's card was never forced out of In Progress - the stuck card this exists to prevent - and
 * two runs exiting within the window shared one slot, so only one net ever fired.
 */
const fallbackTimers = new Map<string, NodeJS.Timeout>();

const fallbackTimerKey = (taskId: string, projectId?: string): string => `${projectId ?? ''}\u0000${taskId}`;

/**
 * The key a task's fallback timer is held under. A run's exit event carries its project, but not
 * always (the task can be deleted or its project removed mid-run), so a timer can be armed without
 * one — and then only a bare lookup can find it again. With two projects holding the id and no
 * project named there is no timer the caller can mean, so nothing is cancelled: letting the net
 * fire is recoverable, cancelling the wrong project's is the stuck card itself.
 */
function findFallbackTimerKey(taskId: string, projectId?: string): string | undefined {
  const exact = fallbackTimerKey(taskId, projectId);
  if (fallbackTimers.has(exact)) return exact;
  if (projectId) {
    const unscoped = fallbackTimerKey(taskId);
    return fallbackTimers.has(unscoped) ? unscoped : undefined;
  }
  const suffix = `\u0000${taskId}`;
  const held = [...fallbackTimers.keys()].filter((key) => key.endsWith(suffix));
  if (held.length === 1) return held[0];
  if (held.length > 1) {
    appLog.warn(
      `[agent-events-handlers] "${taskId}" has a stuck-run timer in more than one project and none `
        + 'was named, so none was cancelled'
    );
  }
  return undefined;
}

/**
 * Register all agent-events-related IPC handlers
 */
export function registerAgenteventsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  taskStateManager.configure(getMainWindow);
  // Every task state and the files tasks edit go to the project's .workbench/changelog.jsonl
  registerTaskChangelog();
  // Parallel tasks message each other and get Workbench's notices about each other
  registerTaskMessaging({ isRunning: (taskId, projectId) => agentManager.isRunning(taskId, projectId) });

  // Learning between sessions: rebuild the project's memory graph when a task completes, so the
  // agents of the next tasks search code that includes its changes
  taskStateManager.setTaskCompletedListener(async (taskId, taskProject) => {
    const project = projectStore.getProject(taskProject.id) ?? taskProject;
    if (!(await isGraphifyEnabled(project.path))) return;
    appLog.info(`[Graphify] Task ${taskId} completed, refreshing the memory graph of ${project.path}`);
    void refreshGraphifyIndex(project.path)
      .then((info) => {
        if (!info) return;
        appLog.info(`[Graphify] Memory graph refreshed: ${info.nodes} nodes, ${info.edges} edges`);
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.GRAPHIFY_INDEX_UPDATED, project.id, info);
      })
      .catch((error) => appLog.warn('[Graphify] Refreshing the memory graph after a task failed:', error));
  });

  // ============================================
  // Agent Manager Events → Renderer
  // ============================================

  agentManager.on("log", (taskId: string, log: string, projectId?: string) => {
    // Use projectId from event when available; fall back to lookup for backward compatibility
    if (!projectId) {
      const { project } = findTaskAndProject(taskId);
      projectId = project?.id;
    }
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOG, taskId, log, projectId);
  });

  agentManager.on("error", (taskId: string, error: string, projectId?: string) => {
    // Use projectId from event when available; fall back to lookup for backward compatibility
    if (!projectId) {
      const { project } = findTaskAndProject(taskId);
      projectId = project?.id;
    }
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, projectId);
  });

  // Handle SDK rate limit events from agent manager
  agentManager.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Handle SDK rate limit events from title generator
  titleGenerator.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Handle auth failure events (401 errors requiring re-authentication)
  agentManager.on("auth-failure", (taskId: string, authFailure: AgentAuthFailure) => {
    console.warn(`[AgentEvents] Auth failure detected for task ${taskId}:`, authFailure);

    // Get profile name for display
    const profileManager = getClaudeProfileManager();
    const profile = authFailure.profileId
      ? profileManager.getProfile(authFailure.profileId)
      : profileManager.getActiveProfile();

    const authFailureInfo: AuthFailureInfo = {
      profileId: authFailure.profileId || profile?.id || 'unknown',
      profileName: profile?.name,
      failureType: authFailure.failureType || 'unknown',
      message: authFailure.message || 'Authentication failed. Please re-authenticate.',
      originalError: authFailure.originalError,
      taskId,
      detectedAt: new Date(),
    };

    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_AUTH_FAILURE, authFailureInfo);
  });

  agentManager.on("exit", (taskId: string, code: number | null, _processType: ProcessType, projectId?: string) => {
    // Use projectId from event to scope the lookup (prevents cross-project contamination)
    const { task: exitTask, project: exitProject } = findTaskAndProject(taskId, projectId);
    const exitProjectId = exitProject?.id || projectId;

    taskStateManager.handleProcessExited(taskId, code, exitTask, exitProject, projectId);

    // Fallback safety net: If XState failed to transition the task out of an active state,
    // force it out after a short delay. This prevents tasks from getting stuck when the run
    // ends without XState seeing its terminal event.
    // We check XState's current state directly to avoid stale cache issues from projectStore.
    // Store timer reference so it can be cancelled if task restarts within the window.
    cancelFallbackTimer(taskId, exitProjectId);
    const timer = setTimeout(() => {
      // The same project the timer is filed under. Reading the state with the event's raw id
      // instead would ask about no project at all when the event carried none, and a task id two
      // projects hold is ambiguous then - the state manager answers nothing, the net reads the card
      // as inactive and never fires, which is the stuck card it exists to prevent
      const currentState = taskStateManager.getCurrentState(taskId, exitProjectId);

      if (currentState && XSTATE_ACTIVE_STATES.has(currentState)) {
        const { task: checkTask, project: checkProject } = findTaskAndProject(taskId, projectId);
        if (checkTask && checkProject) {
          if (code === 0) {
            // Clean exit (code 0) means the run completed but the terminal event
            // (QA_PASSED) was lost in transit. Treat as completed, not stopped.
            console.warn(
              `[agent-events-handlers] Task ${taskId} still in XState ${currentState} ` +
              `${STUCK_TASK_FALLBACK_TIMEOUT_MS}ms after clean exit (code 0), forcing QA_PASSED`
            );
            taskStateManager.handleUiEvent(taskId, {
              type: 'QA_PASSED', iteration: 0, testsRun: {}
            }, checkTask, checkProject);
          } else {
            // Non-zero exit code — the run failed or crashed
            const hasPlan = hasStartedImplementation(checkProject, checkTask);
            console.warn(
              `[agent-events-handlers] Task ${taskId} still in XState ${currentState} ` +
              `${STUCK_TASK_FALLBACK_TIMEOUT_MS}ms after exit (code ${code}), forcing USER_STOPPED (hasPlan: ${hasPlan})`
            );
            taskStateManager.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan }, checkTask, checkProject);
          }
        }
      }
      // Clean up timer reference after it fires
      fallbackTimers.delete(fallbackTimerKey(taskId, exitProjectId));
    }, STUCK_TASK_FALLBACK_TIMEOUT_MS);
    fallbackTimers.set(fallbackTimerKey(taskId, exitProjectId), timer);

    // Send final plan state to renderer BEFORE unwatching, so it has the final subtasks
    const finalPlan = fileWatcher.getCurrentPlan(taskId, exitProjectId);
    if (finalPlan) {
      safeSendToRenderer(
        getMainWindow,
        IPC_CHANNELS.TASK_PROGRESS,
        taskId,
        finalPlan,
        exitProjectId
      );
    }

    // The run that exited is this project's, so its watcher is the one to close: another project
    // can be running a task of the same spec id and still needs its plan updates
    fileWatcher.unwatch(taskId, exitProjectId).catch((err) => {
      console.error(`[agent-events-handlers] Failed to unwatch for ${taskId}:`, err);
    });

    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return;

    // Rate-limit hold: the task is queued for automatic resume, not failed
    if (taskStateManager.getCurrentState(taskId, project.id) === 'queued') return;

    const taskTitle = task.title || task.specId;
    if (code === 0) {
      notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);
    } else {
      notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
    }
  });

  agentManager.on("task-event", (taskId: string, event, projectId?: string) => {
    console.debug(`[agent-events-handlers] Received task-event for ${taskId}:`, event.type, event);

    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) {
      console.debug(`[agent-events-handlers] No task/project found for ${taskId}`);
      return;
    }

    console.debug(`[agent-events-handlers] Task state before handleTaskEvent:`, {
      status: task.status,
      reviewReason: task.reviewReason,
      phase: task.executionProgress?.phase
    });

    // Provider limit hit with a known reset time: persist the hold (and notify the renderer)
    // BEFORE XState moves the task to the queue, so queue auto-promotion sees the hold and skips
    // this task. The task stays on its account and resumes there after the reset.
    if (event.type === "RATE_LIMIT_HOLD") {
      const hold = parseRateLimitHold({ ...event, pausedAt: event.timestamp });
      if (hold) {
        applyRateLimitHold(project, task, hold, getMainWindow);
      }
    }

    const accepted = taskStateManager.handleTaskEvent(taskId, event, task, project);
    console.debug(`[agent-events-handlers] Event ${event.type} accepted: ${accepted}`);
    if (!accepted) {
      return;
    }

    const mainPlanPath = getPlanPath(project, task);
    persistPlanLastEventSync(mainPlanPath, event);

    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (worktreePath) {
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const worktreePlanPath = path.join(
        worktreePath,
        specsBaseDir,
        task.specId,
        AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
      );
      if (existsSync(worktreePlanPath)) {
        persistPlanLastEventSync(worktreePlanPath, event);
      }
    }
  });

  // Claude Code run state (triage, phases, cost, validation) → renderer
  agentManager.on("run-info", (taskId: string, info: ClaudeRunInfo, projectId?: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_CLAUDE_RUN_UPDATE, taskId, info, projectId);
  });

  // Claude Code's task list → the task's subtasks (implementation_plan.json phases)
  agentManager.on("subtasks", (taskId: string, subtasks: TaskRunSubtask[], projectId?: string) => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return;
    const plan = writePlanSubtasksSync(getPlanPath(project, task), subtasks, project.id);
    if (plan) {
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_PROGRESS, taskId, plan as unknown as ImplementationPlan, project.id);
    }
  });

  agentManager.on("execution-progress", (taskId: string, progress: ExecutionProgressData, projectId?: string) => {
    // Use projectId from event to scope the lookup (prevents cross-project contamination)
    const { task, project } = findTaskAndProject(taskId, projectId);
    const taskProjectId = project?.id || projectId;

    // Check if XState has already established a terminal/review state for this task.
    // XState is the source of truth for status. When XState is in a settled state
    // (e.g., error after CODING_FAILED), execution-progress events from the run are
    // stale and must not overwrite XState's persisted status.
    const currentXState = taskStateManager.getCurrentState(taskId, taskProjectId);
    const xstateInTerminalState = currentXState && XSTATE_SETTLED_STATES.has(currentXState);

    // Persist phase to plan file for restoration on app refresh
    // Must persist to BOTH main project and worktree (if exists) since task may be loaded from either
    if (task && project && progress.phase && !xstateInTerminalState) {
      const mainPlanPath = getPlanPath(project, task);
      persistPlanPhaseSync(mainPlanPath, progress.phase, project.id);

      // Also persist to the worktree copy so getTasks() sees the same phase there
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const worktreePlanPath = path.join(
          worktreePath,
          getSpecsDir(project.autoBuildPath),
          task.specId,
          AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
        );
        if (existsSync(worktreePlanPath)) {
          persistPlanPhaseSync(worktreePlanPath, progress.phase, project.id);
        }
      }
    } else if (xstateInTerminalState && progress.phase) {
      console.debug(`[agent-events-handlers] Skipping persistPlanPhaseSync for ${taskId}: XState in '${currentXState}', not overwriting with phase '${progress.phase}'`);
    }

    // Skip sending execution-progress to renderer when XState has settled,
    // UNLESS this is a final phase update (complete/failed) AND the task is still in_progress.
    // This prevents UI flicker where a failed phase arrives after the status has already changed to human_review.
    const isFinalPhaseUpdate = progress.phase === 'complete' || progress.phase === 'failed';
    if (xstateInTerminalState) {
      if (!isFinalPhaseUpdate) {
        console.debug(`[agent-events-handlers] Skipping execution-progress to renderer for ${taskId}: XState in '${currentXState}', ignoring phase '${progress.phase}'`);
        return;
      }
      // For final phase updates, only send if task is still in_progress to prevent flicker
      const { task } = findTaskAndProject(taskId, taskProjectId);
      if (task && task.status !== 'in_progress') {
        console.debug(`[agent-events-handlers] Skipping final phase '${progress.phase}' for ${taskId}: task status is '${task.status}', not 'in_progress'`);
        return;
      }
    }
    safeSendToRenderer(
      getMainWindow,
      IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
      taskId,
      progress,
      taskProjectId
    );
  });

  // ============================================
  // File Watcher Events → Renderer
  // ============================================

  fileWatcher.on("progress", (taskId: string, plan: ImplementationPlan, projectId?: string) => {
    // Every watch is started for one project's spec dir and the event carries that project, so
    // the task is looked up inside it. Searching the projects for the task id used to be the only
    // option here, and it answered with the first project holding the id - which is the wrong
    // project's window and the wrong project's plan file whenever two of them hold a task of the
    // same spec id. A watch that was started without a project still falls back to that search.
    const { task, project } = findTaskAndProject(taskId, projectId);
    // The project the watch belongs to is what routes the update, even if the task lookup above
    // came up empty (a cold cache, a spec dir mid-rewrite)
    const eventProjectId = projectId ?? project?.id;

    // Diagnostic: log subtask status summary for debugging status-not-updating issues.
    // Only log when there are non-pending statuses (reduces noise).
    if (plan.phases?.length) {
      const statusCounts: Record<string, number> = {};
      for (const phase of plan.phases) {
        for (const st of phase.subtasks ?? []) {
          const s = st.status || 'pending';
          statusCounts[s] = (statusCounts[s] || 0) + 1;
        }
      }
      const hasNonPending = Object.keys(statusCounts).some(k => k !== 'pending');
      if (hasNonPending) {
        console.warn(
          `[FileWatcher→Renderer] Task ${taskId} subtask statuses:`,
          statusCounts,
          `| projectId: ${eventProjectId ?? 'UNKNOWN'}`,
        );
      }
    }

    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_PROGRESS, taskId, plan, eventProjectId);

    // Re-stamp XState status fields if the plan file was rewritten without them
    // (otherwise tasks snap back to backlog on refresh).
    const planWithStatus = plan as { xstateState?: string; executionPhase?: string; status?: string };
    // The project the watch belongs to, the same one this handler routed the update to
    const currentXState = taskStateManager.getCurrentState(taskId, eventProjectId ?? project?.id);
    if (currentXState && !planWithStatus.xstateState && task && project) {
      console.debug(`[agent-events-handlers] Re-stamping XState status on plan file for ${taskId} (state: ${currentXState})`);
      const mainPlanPath = getPlanPath(project, task);
      const { status, reviewReason } = mapStateToLegacy(currentXState);
      const phase = XSTATE_TO_PHASE[currentXState] || 'idle';
      persistPlanStatusAndReasonSync(mainPlanPath, status, reviewReason, project.id, currentXState, phase);

      // Also re-stamp worktree copy if it exists
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const worktreePlanPath = path.join(
          worktreePath,
          specsBaseDir,
          task.specId,
          AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
        );
        if (existsSync(worktreePlanPath)) {
          persistPlanStatusAndReasonSync(worktreePlanPath, status, reviewReason, project.id, currentXState, phase);
        }
      }
    }
  });

  fileWatcher.on("error", (taskId: string, error: string, projectId?: string) => {
    // The watch's own project, so the error reaches the window of the project whose plan file it
    // is about; a watch started without one still falls back to searching for the task id
    const project = projectId ? undefined : findTaskAndProject(taskId).project;
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, projectId ?? project?.id);
  });
}

/**
 * Cancel any pending fallback timer for a task.
 * Should be called when a task is restarted to prevent the stale timer
 * from incorrectly stopping the new process.
 */
export function cancelFallbackTimer(taskId: string, projectId?: string): void {
  const key = findFallbackTimerKey(taskId, projectId);
  const timer = key ? fallbackTimers.get(key) : undefined;
  if (key && timer) {
    clearTimeout(timer);
    fallbackTimers.delete(key);
    console.debug(`[agent-events-handlers] Cancelled fallback timer for task ${taskId}`);
  }
}
