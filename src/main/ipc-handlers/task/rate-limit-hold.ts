/**
 * Rate-limit hold persistence
 *
 * A task hits a provider limit with a known reset time → it is put "on hold":
 * moved to the Queue column with `rateLimitHold` persisted in
 * implementation_plan.json (main spec dir + worktree copy, so it survives app
 * restarts and getTasks() dedup), the renderer is notified, and the main-process
 * scheduler resumes it at the reset time.
 */
import path from 'path';
import { existsSync } from 'fs';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, RateLimitHold, Task } from '../../../shared/types';
import { findTaskWorktree } from '../../worktree-paths';
import { rateLimitResumeScheduler } from '../../services/rate-limit-resume-scheduler';
import { safeSendToRenderer } from '../utils';
import { getPlanPath, persistPlanRateLimitHoldSync } from './plan-file-utils';

/** Plan file paths for a task: main spec dir first, then worktree copy if present. */
function getTaskPlanPaths(project: Project, task: Task): string[] {
  const paths = [getPlanPath(project, task)];
  const worktreePath = findTaskWorktree(project.path, task.specId);
  if (worktreePath) {
    const worktreePlanPath = path.join(
      worktreePath,
      getSpecsDir(project.autoBuildPath),
      task.specId,
      AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
    );
    if (existsSync(worktreePlanPath)) {
      paths.push(worktreePlanPath);
    }
  }
  return paths;
}

/**
 * Persist a rate-limit hold, notify the renderer and schedule the resume.
 *
 * Call BEFORE transitioning XState to `queued`: the renderer must see the hold
 * before the status change so queue auto-promotion skips the held task.
 */
export function applyRateLimitHold(
  project: Project,
  task: Task,
  hold: RateLimitHold,
  getMainWindow: () => BrowserWindow | null
): void {
  for (const planPath of getTaskPlanPaths(project, task)) {
    persistPlanRateLimitHoldSync(planPath, hold, project.id);
  }
  safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_RATE_LIMIT_HOLD_CHANGE, task.id, hold, project.id);
  rateLimitResumeScheduler.schedule({ taskId: task.id, projectId: project.id, resetAt: hold.resetAt });
}

/**
 * Clear a task's rate-limit hold (plan files, pending timer, renderer state).
 * Safe to call for tasks that are not on hold.
 */
export function clearRateLimitHold(
  project: Project,
  task: Task,
  getMainWindow: () => BrowserWindow | null
): void {
  const wasScheduled = rateLimitResumeScheduler.isScheduled(task.id);
  rateLimitResumeScheduler.cancel(task.id);
  // The Task object may come from a stale cache, so check the scheduler too.
  if (!task.rateLimitHold && !wasScheduled) return;
  for (const planPath of getTaskPlanPaths(project, task)) {
    persistPlanRateLimitHoldSync(planPath, null, project.id);
  }
  task.rateLimitHold = undefined;
  safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_RATE_LIMIT_HOLD_CHANGE, task.id, null, project.id);
}
