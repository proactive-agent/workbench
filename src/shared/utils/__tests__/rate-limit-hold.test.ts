import { describe, it, expect } from 'vitest';

import { isTaskOnRateLimitHold, parseRateLimitHold } from '../rate-limit-hold';
import { mapStateToLegacy } from '../../state-machines';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const FUTURE = '2026-10-05T16:30:00.000Z';
const PAST = '2026-10-05T09:00:00.000Z';

describe('isTaskOnRateLimitHold', () => {
  it('is true for a queued task whose reset time is in the future', () => {
    expect(
      isTaskOnRateLimitHold({ status: 'queue', rateLimitHold: { resetAt: FUTURE, message: '', pausedAt: PAST } }, NOW)
    ).toBe(true);
  });

  it('is false once the reset time has passed (eligible for normal queue promotion)', () => {
    expect(
      isTaskOnRateLimitHold({ status: 'queue', rateLimitHold: { resetAt: PAST, message: '', pausedAt: PAST } }, NOW)
    ).toBe(false);
  });

  it('is false for queued tasks without a hold and for non-queue statuses', () => {
    expect(isTaskOnRateLimitHold({ status: 'queue' }, NOW)).toBe(false);
    expect(
      isTaskOnRateLimitHold({ status: 'in_progress', rateLimitHold: { resetAt: FUTURE, message: '', pausedAt: PAST } }, NOW)
    ).toBe(false);
  });
});

describe('parseRateLimitHold', () => {
  it('parses a persisted hold', () => {
    expect(
      parseRateLimitHold({ resetAt: FUTURE, message: 'limit', pausedAt: PAST, phase: 'coding' })
    ).toEqual({ resetAt: FUTURE, message: 'limit', pausedAt: PAST, phase: 'coding' });
  });

  it('fills defaults for optional fields', () => {
    expect(parseRateLimitHold({ resetAt: FUTURE })).toEqual({ resetAt: FUTURE, message: '', pausedAt: FUTURE });
  });

  it('rejects malformed values', () => {
    expect(parseRateLimitHold(null)).toBeUndefined();
    expect(parseRateLimitHold('x')).toBeUndefined();
    expect(parseRateLimitHold({ resetAt: 'not-a-date' })).toBeUndefined();
    expect(parseRateLimitHold({ message: 'no reset' })).toBeUndefined();
  });
});

describe('queued XState mapping', () => {
  it('maps the queued state to the Queue column', () => {
    expect(mapStateToLegacy('queued')).toEqual({ status: 'queue' });
  });
});
