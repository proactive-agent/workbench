/**
 * Terminal loading
 * ================
 *
 * A window shows a spinner over its content while it starts (a new agent, a worktree or task
 * switch, another session) instead of the long command the app types and the shell's start-up.
 * What ends it depends on what the window is starting:
 * - `shell`: the shell's first output (its prompt)
 * - `claude`: Claude Code's interface, or a question it waits on (trusting the folder, signing in),
 *   or the read-only view of a running task's session. Only output after the start of the new run
 *   counts: the command the app types and the marker of a Claude Code that just exited both carry
 *   `workbench-cli-exit`, and the Claude Code that is closing redraws its own footer before that
 * Claude Code exiting (the marker after the anchor) ends it too, and so does a timeout.
 */

export type TerminalLoadingKind = 'claude' | 'shell';

/** The longest a spinner stays when nothing ends it */
export const TERMINAL_LOADING_TIMEOUT_MS = 20_000;

/** In the typed command (as text) and in the marker the shell prints when the CLI exits */
const RUN_ANCHOR = 'workbench-cli-exit';

/** Claude Code is ready, or waits on the user */
const CLAUDE_READY = [
  /shift\+tab to cycle/,
  /\? for shortcuts/,
  /(^|\n)\s*❯ /,
  /Do you trust the files/i,
  /Select login method/i,
  /Press Enter to continue/i,
];

/** Shown without any command typed: the read-only view of a running task's session */
const FOLLOWING = /Following this task's Claude Code session/;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g;

interface LoadingState {
  kind: TerminalLoadingKind;
  /** The new run's output has started (the anchor was seen) */
  anchored: boolean;
  /** The end of the output read so far (patterns can be split across chunks) */
  tail: string;
}

const states = new Map<string, LoadingState>();

/** Start watching a window's output for the end of its loading */
export function startTerminalLoading(id: string, kind: TerminalLoadingKind): void {
  states.set(id, { kind, anchored: false, tail: '' });
}

export function stopTerminalLoading(id: string): void {
  states.delete(id);
}

/** Whether this output ends the window's loading (then it is no longer watched) */
export function terminalLoadingEnds(id: string, data: string): boolean {
  const state = states.get(id);
  if (!state) return false;

  let ended: boolean;
  if (state.kind === 'shell') {
    ended = data.replace(ANSI, '').trim().length > 0;
  } else {
    let text = data;
    if (!state.anchored) {
      const anchor = data.indexOf(RUN_ANCHOR);
      if (anchor < 0) {
        ended = FOLLOWING.test(data.replace(ANSI, ''));
        if (ended) states.delete(id);
        return ended;
      }
      state.anchored = true;
      text = data.slice(anchor + RUN_ANCHOR.length);
    } else if (data.includes('\x1b]777;workbench-cli-exit')) {
      // The new Claude Code already exited (a failed start): its message is what to show
      states.delete(id);
      return true;
    }
    state.tail = (state.tail + text.replace(ANSI, '')).slice(-4000);
    ended = CLAUDE_READY.some((pattern) => pattern.test(state.tail)) || FOLLOWING.test(state.tail);
  }
  if (ended) states.delete(id);
  return ended;
}
