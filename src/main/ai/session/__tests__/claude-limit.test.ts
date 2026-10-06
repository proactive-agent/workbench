import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  ClaudeLimitReachedError,
  detectClaudeLimitMessage,
  parseLimitResetTime,
} from '../claude-limit';
import { classifyError, isRateLimitError } from '../error-classifier';
import { parseResetTime } from '../../../claude-profile/usage-parser';

// =============================================================================
// detectClaudeLimitMessage
// =============================================================================

describe('detectClaudeLimitMessage', () => {
  it.each([
    ["You've hit your session limit · resets 8:30pm (Asia/Yerevan)", '8:30pm (Asia/Yerevan)'],
    ["You've hit your weekly limit · resets Dec 17 at 6am (Europe/Oslo)", 'Dec 17 at 6am (Europe/Oslo)'],
    ["You're out of extra usage · resets 8:30pm (Asia/Yerevan)", '8:30pm (Asia/Yerevan)'],
    ['Limit reached · resets Dec 17 at 6am (Europe/Oslo)', 'Dec 17 at 6am (Europe/Oslo)'],
    ['5-hour limit reached ∙ resets 3pm', '3pm'],
    ["You've hit your limit • resets 11:59pm (America/Sao_Paulo)", '11:59pm (America/Sao_Paulo)'],
    ['You’ve hit your session limit · resets 8:30pm (Asia/Yerevan)', '8:30pm (Asia/Yerevan)'],
    ['You’re out of extra usage • resets 8:30pm (Asia/Yerevan).', '8:30pm (Asia/Yerevan)'],
  ])('detects %j', (text, resetText) => {
    const result = detectClaudeLimitMessage(text);
    expect(result).not.toBeNull();
    expect(result?.message).toBe(text.trim());
    expect(result?.resetText).toBe(resetText);
  });

  it('trims surrounding whitespace', () => {
    const result = detectClaudeLimitMessage("\n  You've hit your session limit · resets 8:30pm (Asia/Yerevan)  \n");
    expect(result?.message).toBe("You've hit your session limit · resets 8:30pm (Asia/Yerevan)");
  });

  it('detects a limit message without a reset time', () => {
    const result = detectClaudeLimitMessage("You've hit your session limit");
    expect(result).not.toBeNull();
    expect(result?.resetText).toBeNull();
  });

  it.each([
    '',
    'I implemented the session limit handler.',
    'The log says "You\'ve hit your session limit · resets 8:30pm (Asia/Yerevan)" so we should parse it.',
    "Done.\nYou've hit your session limit · resets 8:30pm (Asia/Yerevan)",
    'Rate limit handling added to the API client',
  ])('ignores normal model output %j', (text) => {
    expect(detectClaudeLimitMessage(text)).toBeNull();
  });

  it('handles null/undefined', () => {
    expect(detectClaudeLimitMessage(null)).toBeNull();
    expect(detectClaudeLimitMessage(undefined)).toBeNull();
  });
});

// =============================================================================
// parseLimitResetTime
// =============================================================================

describe('parseLimitResetTime', () => {
  // Asia/Yerevan is UTC+4 year-round (no DST)
  it('computes today in the given zone when the time is still ahead', () => {
    const now = new Date('2026-10-05T10:00:00Z'); // 14:00 in Yerevan
    const result = parseLimitResetTime('8:30pm (Asia/Yerevan)', now);
    expect(result?.toISOString()).toBe('2026-10-05T16:30:00.000Z');
  });

  it('rolls over to tomorrow when the time already passed today in that zone', () => {
    const now = new Date('2026-10-05T17:00:00Z'); // 21:00 in Yerevan
    const result = parseLimitResetTime('8:30pm (Asia/Yerevan)', now);
    expect(result?.toISOString()).toBe('2026-10-06T16:30:00.000Z');
  });

  it('uses the zone-local calendar date, not the UTC date', () => {
    // 22:30Z on Oct 5 is already 02:30 on Oct 6 in Yerevan
    const now = new Date('2026-10-05T22:30:00Z');
    const result = parseLimitResetTime('8:30pm (Asia/Yerevan)', now);
    expect(result?.toISOString()).toBe('2026-10-06T16:30:00.000Z');
  });

  it('handles zones west of UTC', () => {
    // America/Sao_Paulo is UTC-3 (no DST since 2019)
    const now = new Date('2026-10-05T12:00:00Z'); // 09:00 in Sao Paulo
    const result = parseLimitResetTime('11:59pm (America/Sao_Paulo)', now);
    expect(result?.toISOString()).toBe('2026-10-06T02:59:00.000Z');
  });

  it('handles 12am/12pm correctly', () => {
    const now = new Date('2026-10-05T10:00:00Z'); // 14:00 in Yerevan
    expect(parseLimitResetTime('12am (Asia/Yerevan)', now)?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(parseLimitResetTime('12pm (Asia/Yerevan)', now)?.toISOString()).toBe('2026-10-06T08:00:00.000Z');
  });

  it('parses "Mon DD at Ham" with a zone, honouring DST', () => {
    // Europe/Oslo: CET (UTC+1) in December
    const now = new Date('2026-10-05T10:00:00Z');
    const result = parseLimitResetTime('Dec 17 at 6am (Europe/Oslo)', now);
    expect(result?.toISOString()).toBe('2026-12-17T05:00:00.000Z');
  });

  it('parses a summer date in a DST zone', () => {
    // Europe/Oslo: CEST (UTC+2) in July
    const now = new Date('2026-06-01T10:00:00Z');
    const result = parseLimitResetTime('Jul 3, 10:59am (Europe/Oslo)', now);
    expect(result?.toISOString()).toBe('2026-07-03T08:59:00.000Z');
  });

  it('moves a past date to next year', () => {
    const now = new Date('2026-12-20T10:00:00Z');
    const result = parseLimitResetTime('Dec 17 at 6am (Europe/Oslo)', now);
    expect(result?.toISOString()).toBe('2027-12-17T05:00:00.000Z');
  });

  it('falls back to local time when no zone is given', () => {
    const now = new Date(2026, 9, 5, 14, 0); // local 14:00
    const result = parseLimitResetTime('8:30pm', now);
    expect(result).toEqual(new Date(2026, 9, 5, 20, 30));
  });

  it('falls back to local time for an invalid zone', () => {
    const now = new Date(2026, 9, 5, 21, 0); // local 21:00 -> tomorrow
    const result = parseLimitResetTime('8:30pm (Not/AZone)', now);
    expect(result).toEqual(new Date(2026, 9, 6, 20, 30));
  });

  it('returns null when nothing parseable is present', () => {
    expect(parseLimitResetTime('soon', new Date())).toBeNull();
    expect(parseLimitResetTime('', new Date())).toBeNull();
  });
});

// =============================================================================
// Error classification
// =============================================================================

describe('ClaudeLimitReachedError classification', () => {
  it('classifies as rate_limited and preserves message and reset time', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const limit = detectClaudeLimitMessage("You've hit your session limit · resets 8:30pm (Asia/Yerevan)");
    if (!limit) throw new Error('expected a limit message');
    const error = new ClaudeLimitReachedError(limit, now);

    expect(isRateLimitError(error)).toBe(true);
    const { sessionError, outcome } = classifyError(error);
    expect(outcome).toBe('rate_limited');
    expect(sessionError.code).toBe('rate_limited');
    expect(sessionError.retryable).toBe(true);
    expect(sessionError.message).toBe("You've hit your session limit · resets 8:30pm (Asia/Yerevan)");
    expect(sessionError.rateLimitResetAt).toBe('2026-10-05T16:30:00.000Z');
  });

  it('omits rateLimitResetAt when no reset time is known', () => {
    const error = new ClaudeLimitReachedError({ message: "You've hit your session limit", resetText: null });
    const { sessionError, outcome } = classifyError(error);
    expect(outcome).toBe('rate_limited');
    expect(sessionError.rateLimitResetAt).toBeUndefined();
  });

  it('treats plain "session limit" errors as rate limits', () => {
    expect(isRateLimitError(new Error("You've hit your session limit"))).toBe(true);
    expect(isRateLimitError(new Error("You're out of extra usage"))).toBe(true);
  });
});

// =============================================================================
// usage-parser integration
// =============================================================================

describe('parseResetTime (usage-parser) with an IANA zone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honours the zone in parentheses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    expect(parseResetTime('8:30pm (Asia/Yerevan)').toISOString()).toBe('2026-10-05T16:30:00.000Z');
  });
});
