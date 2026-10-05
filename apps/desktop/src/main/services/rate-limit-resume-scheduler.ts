/**
 * Rate-Limit Resume Scheduler
 * ===========================
 *
 * Main-process scheduler that resumes tasks put on hold by a provider rate
 * limit (e.g. "You've hit your session limit · resets 8:30pm (Asia/Yerevan)").
 *
 * Held tasks sit in the Queue column with a persisted `rateLimitHold.resetAt`.
 * This service arms one timer per held task and, shortly after the reset time,
 * invokes the configured resume callback (which clears the hold and starts the
 * task the same way TASK_START does). It runs in the main process so resuming
 * works regardless of renderer/UI state, and re-scans on app start so holds
 * survive restarts.
 */

/** Delay after the advertised reset time before resuming (limits can lag slightly). */
export const RESUME_BUFFER_MS = 60_000;

/** Minimum delay before resuming (holds whose reset already passed resume promptly). */
export const MIN_RESUME_DELAY_MS = 5_000;

/** setTimeout's maximum delay (2^31 - 1 ms ≈ 24.8 days); longer waits are re-armed. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Reference to a held task. */
export interface HeldTaskRef {
  taskId: string;
  projectId: string;
  /** ISO 8601 reset time */
  resetAt: string;
}

export interface RateLimitResumeSchedulerDeps {
  /** Enumerate all held tasks across projects (used on startup). */
  listHeldTasks: () => HeldTaskRef[];
  /** Resume a held task (clear hold + start). Errors are caught and logged. */
  resumeTask: (taskId: string, projectId: string) => void | Promise<void>;
  /** Clock override for tests. */
  now?: () => number;
  /** Buffer override for tests. */
  bufferMs?: number;
}

/**
 * Compute how long to wait before resuming a task held until `resetAt`.
 * Invalid or past reset times resume after MIN_RESUME_DELAY_MS.
 */
export function computeResumeDelay(
  resetAt: string | Date,
  now: number,
  bufferMs: number = RESUME_BUFFER_MS
): number {
  const resetMs = resetAt instanceof Date ? resetAt.getTime() : Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return MIN_RESUME_DELAY_MS;
  return Math.max(MIN_RESUME_DELAY_MS, resetMs + bufferMs - now);
}

interface ScheduledEntry {
  ref: HeldTaskRef;
  timer: ReturnType<typeof setTimeout>;
}

export class RateLimitResumeScheduler {
  private deps: RateLimitResumeSchedulerDeps | null = null;
  private entries = new Map<string, ScheduledEntry>();

  configure(deps: RateLimitResumeSchedulerDeps): void {
    this.deps = deps;
  }

  /** Schedule (or reschedule) a resume for a held task. */
  schedule(ref: HeldTaskRef): void {
    this.cancel(ref.taskId);
    this.arm(ref);
  }

  /** Cancel a pending resume (e.g. the user started or moved the task manually). */
  cancel(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry) {
      clearTimeout(entry.timer);
      this.entries.delete(taskId);
    }
  }

  /** Whether a resume is pending for the task. */
  isScheduled(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /** Scheduled reset time for a task, if any. */
  getScheduledResetAt(taskId: string): string | undefined {
    return this.entries.get(taskId)?.ref.resetAt;
  }

  /**
   * Scan all projects for held tasks and schedule them.
   * @returns Number of tasks scheduled.
   */
  scanAndScheduleAll(): number {
    if (!this.deps) return 0;
    let count = 0;
    try {
      for (const ref of this.deps.listHeldTasks()) {
        this.schedule(ref);
        count++;
      }
    } catch (error) {
      console.warn('[RateLimitResumeScheduler] Failed to scan held tasks:', error);
    }
    return count;
  }

  /** Clear all timers. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  private arm(ref: HeldTaskRef): void {
    const delay = computeResumeDelay(ref.resetAt, this.now(), this.deps?.bufferMs ?? RESUME_BUFFER_MS);
    if (delay > MAX_TIMER_DELAY_MS) {
      // setTimeout overflows above 2^31-1 ms and would fire immediately; re-arm in chunks.
      const timer = setTimeout(() => {
        this.entries.delete(ref.taskId);
        this.arm(ref);
      }, MAX_TIMER_DELAY_MS);
      this.entries.set(ref.taskId, { ref, timer });
      return;
    }
    const timer = setTimeout(() => {
      this.entries.delete(ref.taskId);
      void this.fire(ref);
    }, delay);
    this.entries.set(ref.taskId, { ref, timer });
  }

  private async fire(ref: HeldTaskRef): Promise<void> {
    if (!this.deps) return;
    try {
      await this.deps.resumeTask(ref.taskId, ref.projectId);
    } catch (error) {
      console.warn(`[RateLimitResumeScheduler] Failed to resume task ${ref.taskId}:`, error);
    }
  }
}

/** App-wide scheduler instance (configured in registerTaskExecutionHandlers). */
export const rateLimitResumeScheduler = new RateLimitResumeScheduler();
