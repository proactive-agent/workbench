/**
 * A chat's Claude Code session open in an agent window too
 * ========================================================
 *
 * A Claude chat's session can be opened in an agent window (the chat's Clawd button) and a
 * window's session as a chat ("Open as chat"): then both work in one session, which must not
 * branch. They take turns:
 * - while the chat replies in it, the window running it is read-only (receiving.ts), and once the
 *   reply ends the window resumes the session again, so its Claude Code has the chat's turn
 * - while the window's Claude Code works, the chat doesn't send; when it goes on, it takes what was
 *   said in the window from the transcript first (insights-service.ts), so it continues from there
 *
 * The window running a session is found by the session its Claude Code runs (`claude agents`),
 * else the one it last started or resumed (agent-sessions.json).
 */
import type { SessionMessageOrigin } from '../../shared/types';
import { windowSessionAccount } from '../terminal/cli-integration-handler';
import { isClaudeBusyNow } from '../terminal/terminal-event-handler';
import type { TerminalProcess } from '../terminal/types';
import { projectWindows, reopenWindowSession } from './directory';
import { windowLiveSession } from './live-sessions';
import { holdForChatReply, releaseChatReply } from './receiving';

/** A window running a session, and whether its Claude Code works on something now */
export interface SessionWindow {
  terminal: TerminalProcess;
  busy: boolean;
}

/**
 * The session a window runs and its status: its Claude Code's live session (`claude agents`,
 * which knows whether it is working; the window's output alone misses that at times), else the
 * one it last started or resumed
 */
async function windowSession(terminal: TerminalProcess): Promise<{ sessionId?: string; busy: boolean }> {
  const live = terminal.isCLIMode ? await windowLiveSession(terminal).catch(() => undefined) : undefined;
  // Claude Code's own status when it reports one: the output's busy state can miss the end of a turn
  const busy = terminal.isCLIMode && (live?.status ? live.status === 'busy' : isClaudeBusyNow(terminal.id));
  if (live?.sessionId) return { sessionId: live.sessionId, busy };
  return { sessionId: (await windowSessionAccount(terminal).catch(() => ({ own: undefined }))).own?.sessionId, busy };
}

/**
 * The project's open agent window that runs a session (or last ran it and is back at its shell,
 * where it can resume it), preferring one running Claude Code, with whether it is working.
 * Windows following a task's run read-only are left out
 */
export async function sessionWindow(projectPath: string, sessionId: string): Promise<SessionWindow | undefined> {
  const windows = projectWindows(projectPath).filter((terminal) => !terminal.follower);
  const ordered = [...windows.filter((terminal) => terminal.isCLIMode), ...windows.filter((terminal) => !terminal.isCLIMode)];
  for (const terminal of ordered) {
    const session = await windowSession(terminal);
    if (session.sessionId === sessionId) return { terminal, busy: session.busy };
  }
  return undefined;
}

/** The window running the session while its Claude Code works on something, if one does */
export async function busyWindowOfSession(projectPath: string, sessionId: string): Promise<TerminalProcess | undefined> {
  const found = await sessionWindow(projectPath, sessionId);
  return found?.busy ? found.terminal : undefined;
}

/**
 * A chat starts a reply in a session: the window running it is read-only until the returned
 * function is called (when the reply ended), which also has the window resume the session again,
 * so its Claude Code has the chat's turn
 */
export async function shareSessionForReply(
  projectPath: string,
  sessionId: string,
  chat: SessionMessageOrigin
): Promise<() => Promise<void>> {
  const terminal = (await sessionWindow(projectPath, sessionId))?.terminal;
  if (!terminal) return async () => undefined;
  holdForChatReply(terminal.id, chat);
  return async () => {
    releaseChatReply(terminal.id);
    // Still running the session in Claude Code (not closed, exited or moved on, and not working on
    // something the user took the window over to type): it picks the session up again with the
    // chat's turn in it
    const now = await sessionWindow(projectPath, sessionId).catch(() => undefined);
    if (now?.terminal.id !== terminal.id || !terminal.isCLIMode || now.busy) return;
    await reopenWindowSession(terminal.id, sessionId).catch(() => undefined);
  };
}
