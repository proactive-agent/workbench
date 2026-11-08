/**
 * An agent window answering a message from a chat is read-only: when a chat's turn sends it a
 * message (Claude Code's SendMessage, seen in the turn's stream), the window ignores keys until its
 * Claude Code has worked on the message and gone idle, so the user's typing doesn't mix into the
 * prompt Claude Code takes the message up in. The window's header shows who it answers and a
 * Take over button that gives the window back at once.
 *
 * Done is busy, then idle for a few seconds (a message that arrives mid-turn waits for that turn
 * to end, and the next one starts right after). Busy and idle come from the window's output as it
 * arrives, and every few seconds from `claude agents` (its session's status), which a missed
 * footer can't fool. A window that never starts working is given back after a while, and none
 * stays read-only longer than MAX_MS.
 */
import type { SessionMessageOrigin } from '../../shared/types';

/** Idle this long after working: the message is answered */
const IDLE_MS = 3000;
/** Never started working: the message didn't arrive or needs nothing */
const START_MS = 30_000;
/** Read-only at most this long */
const MAX_MS = 30 * 60_000;
/** How often the session's status is asked of `claude agents` */
const POLL_MS = 4000;

interface Receiving {
  from: SessionMessageOrigin;
  sawBusy: boolean;
  timer?: ReturnType<typeof setTimeout>;
  limit: ReturnType<typeof setTimeout>;
  poll: ReturnType<typeof setInterval>;
}

const receiving = new Map<string, Receiving>();

let notify: (terminalId: string, from: SessionMessageOrigin | null) => void = () => {};
let busyNow: (terminalId: string) => boolean = () => false;
let sessionStatus: (terminalId: string) => Promise<string | undefined> = async () => undefined;

/**
 * How the renderer hears of it, and how a window's Claude Code is known to be working: from its
 * output (`isBusy`) and from `claude agents` (`status`: 'busy', 'idle', ...)
 */
export function setReceivingHooks(hooks: {
  notify: (terminalId: string, from: SessionMessageOrigin | null) => void;
  isBusy: (terminalId: string) => boolean;
  status?: (terminalId: string) => Promise<string | undefined>;
}): void {
  notify = hooks.notify;
  busyNow = hooks.isBusy;
  sessionStatus = hooks.status ?? (async () => undefined);
}

/**
 * Whether the window is answering a message (its keys are ignored)
 * @internal
 */
export function isReceiving(terminalId: string): boolean {
  return receiving.has(terminalId);
}

/**
 * What xterm sends on its own, answering the program in the window: focus in and out, device
 * attributes, mode, keyboard and window reports, OSC and DCS replies. These still go through while
 * the window is read-only; Claude Code may be waiting for one (cursor reports: CURSOR_REPORT)
 */
const TERMINAL_REPLY = new RegExp(
  '^(?:' + [
    '\\x1b\\[[IO]', // focus in and out
    '\\x1b\\[[?>=]?[\\d;]*c', // device attributes
    '\\x1b\\[\\??\\d+;\\d+\\$y', // mode reports (DECRPM)
    '\\x1b\\[\\?\\d*u', // kitty keyboard flags
    '\\x1b\\[\\d+(?:;\\d+)*t', // window size and state reports
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC replies (colors)
    '\\x1bP[^\\x1b]*\\x1b\\\\', // DCS replies
  ].join('|') + ')+$'
);

/**
 * A cursor position report: also what Shift/Ctrl+F3 sends (`\x1b[1;2R`), so it goes through only
 * right after the program asked for one (`\x1b[6n`, seen in the window's output)
 */
const CURSOR_REPORT = /^(?:\x1b\[\??\d+;\d+R)+$/;
const CURSOR_REPORT_MS = 2000;
const cursorAsked = new Map<string, number>();

/** The window's program asked for the cursor position (its output had `\x1b[6n`) */
export function noteCursorQuery(terminalId: string): void {
  if (receiving.has(terminalId)) cursorAsked.set(terminalId, Date.now());
}

/** Whether input the window's xterm sent goes to its program: always, except the user's while read-only */
export function acceptsWindowInput(terminalId: string, data: string): boolean {
  if (!receiving.has(terminalId) || TERMINAL_REPLY.test(data)) return true;
  if (!CURSOR_REPORT.test(data)) return false;
  const asked = cursorAsked.get(terminalId);
  cursorAsked.delete(terminalId);
  return asked !== undefined && Date.now() - asked < CURSOR_REPORT_MS;
}

function setTimer(terminalId: string, entry: Receiving, ms: number): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => stopReceiving(terminalId), ms);
}

/** A message was sent to the window: read-only until it is answered */
export function startReceiving(terminalId: string, from: SessionMessageOrigin): void {
  const previous = receiving.get(terminalId);
  if (previous) clearTimers(previous);
  const entry: Receiving = {
    from,
    sawBusy: busyNow(terminalId),
    limit: setTimeout(() => stopReceiving(terminalId), MAX_MS),
    poll: setInterval(() => {
      void sessionStatus(terminalId).then((status) => {
        if (receiving.get(terminalId) !== entry || !status) return;
        if (status === 'busy') receivingBusyChanged(terminalId, true);
        // Idle as Claude Code itself reports it: the output's idle may have been missed
        else if (status === 'idle' && entry.sawBusy && !entry.timer) receivingBusyChanged(terminalId, false);
      }).catch(() => undefined);
    }, POLL_MS),
  };
  receiving.set(terminalId, entry);
  // Working on another prompt: the message comes after it
  if (!entry.sawBusy) setTimer(terminalId, entry, START_MS);
  notify(terminalId, from);
}

/** The window's Claude Code started or stopped working */
export function receivingBusyChanged(terminalId: string, isBusy: boolean): void {
  const entry = receiving.get(terminalId);
  if (!entry) return;
  if (isBusy) {
    entry.sawBusy = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  } else if (entry.sawBusy) {
    setTimer(terminalId, entry, IDLE_MS);
  }
}

/** Give the window back: answered, taken over, Claude Code exited or the window closed */
export function stopReceiving(terminalId: string): void {
  const entry = receiving.get(terminalId);
  if (!entry) return;
  clearTimers(entry);
  receiving.delete(terminalId);
  cursorAsked.delete(terminalId);
  notify(terminalId, null);
}

function clearTimers(entry: Receiving): void {
  if (entry.timer) clearTimeout(entry.timer);
  clearTimeout(entry.limit);
  clearInterval(entry.poll);
}
