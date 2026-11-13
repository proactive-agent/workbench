/**
 * A chat's Claude Code session open in an agent window too
 * ========================================================
 *
 * A Claude chat's session can be opened in an agent window (the chat's Clawd button) and a
 * window's session as a chat ("Open as chat"): then both work in one session, which must not
 * branch. They take turns:
 * - while the chat replies in it, the window running it is read-only (receiving.ts, a hold per
 *   reply), and once the last reply holding it ends the window resumes the session again, so its
 *   Claude Code has the chat's turn
 * - while the window's Claude Code works, the chat doesn't reply; when it goes on, it takes what
 *   was said in the window from the transcript first (insights-service.ts), so it continues from
 *   there
 *
 * The windows that may run a session are the ones that recorded it (started or resumed it:
 * agent-sessions.json, and the run's own record), so a chat without one costs nothing; one running
 * Claude Code counts only while `claude agents` says it runs that session (after /clear or /resume
 * it runs another), and is busy unless Claude Code reports it idle.
 */
import type { SessionMessageOrigin } from '../../shared/types';
import { windowOfSession } from '../agent-session-store';
import { windowSessionAccount } from '../terminal/cli-integration-handler';
import { isClaudeBusyNow } from '../terminal/terminal-event-handler';
import type { TerminalProcess } from '../terminal/types';
import { shellIsIdle } from './agent-windows';
import { projectWindows, reopenWindowSession } from './directory';
import { windowLiveSession } from './live-sessions';
import { heldForChatReply, holdForChatReply, releaseChatReply } from './receiving';

/** A window running a session (or back at its shell after running it), and what it is doing */
export interface SessionWindow {
  terminal: TerminalProcess;
  /** Its Claude Code works on something (also waiting on a permission prompt mid-turn) */
  busy: boolean;
  /** Back at its shell: the session can be resumed there when nothing else runs in it (`shellIdle`) */
  atShell: boolean;
  shellIdle: boolean;
}

/** The project's windows that started or resumed the session (no `claude agents` needed for that) */
async function recordedWindows(projectPath: string, sessionId: string): Promise<TerminalProcess[]> {
  const windows = projectWindows(projectPath).filter((terminal) => !terminal.follower);
  const recorded = await Promise.all(windows.map(async (terminal) => {
    if (windowOfSession(sessionId) === terminal.id) return true;
    const { own } = await windowSessionAccount(terminal).catch(() => ({ own: undefined }));
    return own?.sessionId === sessionId;
  }));
  return windows.filter((_, index) => recorded[index]);
}

/**
 * The project's agent window that runs a session (one running Claude Code first), or last ran it
 * and is back at its shell, with what it is doing. Windows following a task's run read-only are
 * left out
 */
export async function sessionWindow(projectPath: string, sessionId: string): Promise<SessionWindow | undefined> {
  const candidates = await recordedWindows(projectPath, sessionId);
  for (const terminal of candidates.filter((candidate) => candidate.isCLIMode)) {
    // Its Claude Code's own session and status (the window may have moved on with /clear or /resume)
    const live = await windowLiveSession(terminal).catch(() => undefined);
    if (live?.sessionId !== sessionId) continue;
    const busy = live.status ? live.status !== 'idle' : isClaudeBusyNow(terminal.id);
    return { terminal, busy, atShell: false, shellIdle: false };
  }
  const atShell = candidates.find((candidate) => !candidate.isCLIMode);
  return atShell ? { terminal: atShell, busy: false, atShell: true, shellIdle: shellIsIdle(atShell) } : undefined;
}

/**
 * A chat starts a reply in a session a window runs: the window is read-only until the returned
 * function is called (when the reply ended). Then, unless another reply holds it by now, the window
 * resumes the session again, so its Claude Code has the chat's turn. A window back at its shell is
 * left alone (the user may be working there; the session resumes when they open it again)
 */
export function shareSessionForReply(
  projectPath: string,
  found: SessionWindow,
  sessionId: string,
  chat: SessionMessageOrigin
): () => Promise<void> {
  const { terminal } = found;
  if (found.atShell) return async () => undefined;
  const hold = holdForChatReply(terminal.id, chat);
  return async () => {
    if (releaseChatReply(terminal.id, hold)) return;
    // Still running the session in Claude Code (not closed, exited or moved on, and not working on
    // something the user took the window over to type); no reply took it again meanwhile
    const now = await sessionWindow(projectPath, sessionId).catch(() => undefined);
    if (now?.terminal.id !== terminal.id || now.atShell || now.busy || heldForChatReply(terminal.id)) return;
    await reopenWindowSession(terminal.id, sessionId).catch(() => undefined);
  };
}
