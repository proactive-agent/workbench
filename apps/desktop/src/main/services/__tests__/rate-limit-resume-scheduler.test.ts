import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
  RateLimitResumeScheduler,
  computeResumeDelay,
  MAX_TIMER_DELAY_MS,
  MIN_RESUME_DELAY_MS,
  RESUME_BUFFER_MS,
} from '../rate-limit-resume-scheduler';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

describe('computeResumeDelay', () => {
  it('waits until resetAt plus the buffer', () => {
    const resetAt = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(computeResumeDelay(resetAt, NOW)).toBe(60 * 60 * 1000 + RESUME_BUFFER_MS);
  });

  it('resumes promptly when resetAt already passed (e.g. app was closed)', () => {
    const resetAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(computeResumeDelay(resetAt, NOW)).toBe(MIN_RESUME_DELAY_MS);
  });

  it('treats invalid dates as due', () => {
    expect(computeResumeDelay('not-a-date', NOW)).toBe(MIN_RESUME_DELAY_MS);
  });

  it('accepts Date objects and custom buffers', () => {
    expect(computeResumeDelay(new Date(NOW + 10_000), NOW, 0)).toBe(10_000);
  });
});

describe('RateLimitResumeScheduler', () => {
  let scheduler: RateLimitResumeScheduler;
  let resumeTask: Mock<(taskId: string, projectId: string) => void | Promise<void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    scheduler = new RateLimitResumeScheduler();
    resumeTask = vi.fn<(taskId: string, projectId: string) => void | Promise<void>>();
    scheduler.configure({ listHeldTasks: () => [], resumeTask, bufferMs: 0 });
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('resumes the task at its reset time', () => {
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(NOW + 60_000).toISOString() });
    expect(scheduler.isScheduled('t1')).toBe(true);

    vi.advanceTimersByTime(59_999);
    expect(resumeTask).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resumeTask).toHaveBeenCalledWith('t1', 'p1');
    expect(scheduler.isScheduled('t1')).toBe(false);
  });

  it('cancel() prevents the resume', () => {
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(NOW + 60_000).toISOString() });
    scheduler.cancel('t1');
    vi.advanceTimersByTime(120_000);
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('rescheduling replaces the previous timer', () => {
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(NOW + 60_000).toISOString() });
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(NOW + 120_000).toISOString() });
    vi.advanceTimersByTime(60_000);
    expect(resumeTask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect(scheduler.getScheduledResetAt('t1')).toBeUndefined();
  });

  it('re-arms waits longer than the setTimeout maximum instead of firing early', () => {
    const resetMs = NOW + MAX_TIMER_DELAY_MS + 10 * 60_000; // ~24.8 days + 10 min
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(resetMs).toISOString() });

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
    expect(resumeTask).not.toHaveBeenCalled();
    expect(scheduler.isScheduled('t1')).toBe(true);

    vi.advanceTimersByTime(10 * 60_000);
    expect(resumeTask).toHaveBeenCalledTimes(1);
  });

  it('scanAndScheduleAll() schedules held tasks found on startup, including overdue ones', () => {
    scheduler.configure({
      listHeldTasks: () => [
        { taskId: 'overdue', projectId: 'p1', resetAt: new Date(NOW - 60_000).toISOString() },
        { taskId: 'future', projectId: 'p2', resetAt: new Date(NOW + 60 * 60_000).toISOString() },
      ],
      resumeTask,
      bufferMs: 0,
    });

    expect(scheduler.scanAndScheduleAll()).toBe(2);

    vi.advanceTimersByTime(MIN_RESUME_DELAY_MS);
    expect(resumeTask).toHaveBeenCalledWith('overdue', 'p1');
    expect(resumeTask).not.toHaveBeenCalledWith('future', 'p2');

    vi.advanceTimersByTime(60 * 60_000);
    expect(resumeTask).toHaveBeenCalledWith('future', 'p2');
  });

  it('swallows resume errors', async () => {
    resumeTask.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    scheduler.schedule({ taskId: 't1', projectId: 'p1', resetAt: new Date(NOW).toISOString() });
    await vi.advanceTimersByTimeAsync(MIN_RESUME_DELAY_MS);
    expect(resumeTask).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
