/**
 * Rate-limit hold helpers shared by the main process and renderer.
 *
 * A task on hold sits in the Queue column until its provider limit resets.
 * See RateLimitHold in shared/types/task.ts.
 */
import type { RateLimitHold, Task } from '../types/task';

/**
 * Validate an untrusted value (e.g. read from implementation_plan.json) as a RateLimitHold.
 * Returns undefined when the value is missing or malformed.
 */
export function parseRateLimitHold(value: unknown): RateLimitHold | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.resetAt !== 'string' || Number.isNaN(Date.parse(raw.resetAt))) return undefined;
  return {
    resetAt: raw.resetAt,
    message: typeof raw.message === 'string' ? raw.message : '',
    pausedAt: typeof raw.pausedAt === 'string' ? raw.pausedAt : raw.resetAt,
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
  };
}

/**
 * Whether a task is currently held by a rate limit, i.e. it is queued with a
 * reset time still in the future. Held tasks must not be auto-promoted from the
 * queue, otherwise they would immediately hit the limit again.
 */
export function isTaskOnRateLimitHold(
  task: Pick<Task, 'status' | 'rateLimitHold'>,
  now: number = Date.now()
): boolean {
  if (task.status !== 'queue' || !task.rateLimitHold) return false;
  const resetAt = Date.parse(task.rateLimitHold.resetAt);
  return !Number.isNaN(resetAt) && resetAt > now;
}
