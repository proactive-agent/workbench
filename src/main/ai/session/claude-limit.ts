/**
 * Claude Limit Messages
 * =====================
 *
 * Claude subscription limits (session / weekly / extra usage) are not always
 * surfaced as HTTP 429 errors. When using a Claude Code subscription the model
 * stream can instead complete "successfully" with a single assistant text
 * message such as:
 *
 *   "You've hit your session limit · resets 8:30pm (Asia/Yerevan)"
 *   "You're out of extra usage · resets 8:30pm (Asia/Yerevan)"
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *
 * This module detects those messages and converts the human-readable reset
 * string into an absolute Date, honouring the IANA time zone in parentheses.
 */

// =============================================================================
// Detection
// =============================================================================

/** Information extracted from a Claude limit message. */
export interface ClaudeLimitMessage {
  /** The original (trimmed) limit message */
  message: string;
  /** The raw reset string, e.g. "8:30pm (Asia/Yerevan)", or null if absent */
  resetText: string | null;
}

/**
 * Limit messages are short, standalone responses. Anything longer is almost
 * certainly real model output that happens to quote such a message.
 */
const MAX_LIMIT_MESSAGE_LENGTH = 300;

/** Apostrophe variants: straight, right single quote, modifier letter apostrophe */
const APOS = "['’ʼ]";

/** Separator variants: middle dot, bullet, bullet operator, hyphen, en/em dash, pipe */
const SEP = '[·•∙|\\-–—]';

/**
 * Anchored pattern for the whole limit message (case-insensitive).
 * Group 1: the reset string (optional).
 */
const CLAUDE_LIMIT_MESSAGE_PATTERN = new RegExp(
  '^(?:' +
    // "You've hit your session limit", "You've hit your weekly limit", "You've hit your limit"
    `you${APOS}ve hit your (?:[\\w-]+ ){0,3}limit` +
    // "You're out of extra usage"
    `|you${APOS}re out of (?:extra )?usage` +
    // "Limit reached", "5-hour limit reached", "Opus weekly limit reached"
    '|(?:[\\w-]+ ){0,3}limit reached' +
  ')' +
  `(?:\\s*${SEP}\\s*resets?\\s+(.+?))?` +
  '[.!]?$',
  'i',
);

/**
 * Detect a Claude subscription limit message in model response text.
 *
 * Only matches when the (trimmed) text consists solely of the limit message,
 * so normal assistant output that mentions limits is never misclassified.
 */
export function detectClaudeLimitMessage(text: string | null | undefined): ClaudeLimitMessage | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LIMIT_MESSAGE_LENGTH || trimmed.includes('\n')) {
    return null;
  }
  const match = trimmed.match(CLAUDE_LIMIT_MESSAGE_PATTERN);
  if (!match) return null;
  const resetText = match[1]?.trim().replace(/[.!]+$/, '') || null;
  return { message: trimmed, resetText };
}

/**
 * Error thrown by the session runner when the model responds with a Claude
 * limit message instead of doing work. Classified as a rate limit.
 */
export class ClaudeLimitReachedError extends Error {
  readonly limit: ClaudeLimitMessage;
  /** Absolute reset time, or null if it could not be determined */
  readonly resetAt: Date | null;

  constructor(limit: ClaudeLimitMessage, now: Date = new Date()) {
    super(limit.message);
    this.name = 'ClaudeLimitReachedError';
    this.limit = limit;
    this.resetAt = limit.resetText ? parseLimitResetTime(limit.resetText, now) : null;
  }
}

// =============================================================================
// Reset time parsing
// =============================================================================

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Wall-clock date/time components (month is 0-based). */
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Return true if `zone` is a valid IANA time zone for Intl. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of `date` in `timeZone`. */
function getWallTime(date: Date, timeZone: string): WallTime & { second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month') - 1,
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date` (positive east of UTC). */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const wall = getWallTime(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/** Convert a wall-clock time in `timeZone` to an absolute Date. */
function wallTimeToDate(wall: WallTime, timeZone: string): Date {
  const naiveUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  // Two passes handle DST transitions between the guess and the real instant.
  let offset = getTimeZoneOffsetMs(new Date(naiveUtc), timeZone);
  let result = naiveUtc - offset;
  const offset2 = getTimeZoneOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = naiveUtc - offset;
  }
  return new Date(result);
}

/**
 * Parse a Claude reset string into the NEXT matching absolute instant.
 *
 * Supported shapes (time zone in parentheses is optional):
 *   "8:30pm (Asia/Yerevan)"         -> today/tomorrow 20:30 in Asia/Yerevan
 *   "6am"                           -> today/tomorrow 06:00 in local time
 *   "Dec 17 at 6am (Europe/Oslo)"   -> Dec 17 06:00 Oslo (next year if passed)
 *   "Nov 1, 10:59am"                -> Nov 1 10:59 local
 *
 * Without a valid IANA zone the wall time is interpreted in the local zone.
 *
 * @returns The reset Date, or null if no time/date could be parsed.
 */
export function parseLimitResetTime(resetText: string, now: Date = new Date()): Date | null {
  if (!resetText) return null;

  // Extract and validate the "(Area/City)" time zone
  const zoneMatch = resetText.match(/\(([^()]+)\)/);
  const zoneCandidate = zoneMatch?.[1]?.trim();
  const timeZone = zoneCandidate && isValidTimeZone(zoneCandidate) ? zoneCandidate : undefined;
  const body = (zoneMatch ? resetText.replace(zoneMatch[0], ' ') : resetText).trim();

  // Optional "Mon DD" date
  const dateMatch = body.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  const bodyWithoutDate = dateMatch ? body.replace(dateMatch[0], ' ') : body;

  // Time: "8:30pm", "6am", "18:00"
  const timeMatch =
    bodyWithoutDate.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ??
    bodyWithoutDate.match(/\b(\d{1,2}):(\d{2})\b/);

  if (!dateMatch && !timeMatch) return null;

  let hour = 0;
  let minute = 0;
  if (timeMatch) {
    hour = Number.parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? Number.parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }

  // "Today" in the target zone (or local zone)
  const today: WallTime = timeZone
    ? { ...getWallTime(now, timeZone) }
    : {
        year: now.getFullYear(),
        month: now.getMonth(),
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
      };

  const toDate = (wall: WallTime): Date =>
    timeZone
      ? wallTimeToDate(wall, timeZone)
      : new Date(wall.year, wall.month, wall.day, wall.hour, wall.minute);

  if (dateMatch) {
    const month = MONTHS[dateMatch[1].slice(0, 3).toLowerCase()];
    const day = Number.parseInt(dateMatch[2], 10);
    let candidate = toDate({ year: today.year, month, day, hour, minute });
    if (candidate.getTime() <= now.getTime()) {
      candidate = toDate({ year: today.year + 1, month, day, hour, minute });
    }
    return candidate;
  }

  let candidate = toDate({ year: today.year, month: today.month, day: today.day, hour, minute });
  if (candidate.getTime() <= now.getTime()) {
    // Date.UTC / new Date normalise day overflow (e.g. Jan 32 -> Feb 1)
    candidate = toDate({ year: today.year, month: today.month, day: today.day + 1, hour, minute });
  }
  return candidate;
}
