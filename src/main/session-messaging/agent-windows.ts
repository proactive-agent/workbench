/**
 * Agent windows a message can reach, closed ones too. A window's name (`agent-<first 8 of its
 * id>`) outlives the window: `.workbench/agent-sessions.json` keeps the sessions each window
 * started, so a name pasted after its window closed still stands for that window's last session.
 * Messaging a closed window opens it again in the background (the same id, so the same name,
 * resuming its session in the folder it ran in), and the message waits until its Claude Code is
 * running, which is when `list_sessions` gives the name SendMessage reaches it by. An open window
 * back at its shell resumes its session the same way.
 */
import { access } from 'fs/promises';
import { agentSessionName } from '../../shared/utils/session-names';
import type { AgentWindowMatch, AgentWindowOpenRequest, SessionMessageOrigin } from '../../shared/types';
import { noteWindowSession, readAgentSessions, type AgentSessionRecord } from '../agent-session-store';
import { readSessionName } from '../terminal/claude-sessions';
import { sessionSearchDirs } from '../terminal/cli-integration-handler';
import { toRuntimePath } from '../platform/shell-runtime';
import type { TerminalProcess } from '../terminal/types';
import { projectWindows, findWindow } from './directory';
import { windowLiveSession } from './live-sessions';
import { startReceiving } from './receiving';
import { windowAcceptsMessages } from './window-tools';

/** How long a window opened for a message may take to run Claude Code */
const OPEN_TIMEOUT_MS = 60_000;
const OPEN_POLL_MS = 1000;

let opener: (request: AgentWindowOpenRequest) => void = () => {};

/** How a window is opened again (the renderer adds it to the project's agent windows) */
export function setAgentWindowOpener(open: (request: AgentWindowOpenRequest) => void): void {
  opener = open;
}

/** The last session a window of the project started, by the window's name */
async function recordedSession(projectPath: string, name: string): Promise<AgentSessionRecord | undefined> {
  const sessions = await readAgentSessions(projectPath).catch(() => []);
  return sessions.filter((session) => session.terminalId && agentSessionName(session.terminalId) === name).pop();
}

/** The folder a recorded session ran in, when it isn't the project's (a worktree) and is still there */
async function recordedCwd(projectPath: string, session: AgentSessionRecord): Promise<string | undefined> {
  if (!session.cwd || session.cwd === projectPath) return undefined;
  return access(session.cwd).then(() => session.cwd, () => undefined);
}

/** The name `/resume` shows for a recorded session (its transcript is named after its folder) */
async function recordedTitle(projectPath: string, session: AgentSessionRecord): Promise<string | undefined> {
  const dir = sessionSearchDirs(session.configDir)[0];
  return dir ? readSessionName(dir, toRuntimePath(session.cwd || projectPath), session.sessionId) : undefined;
}

/** An agent window of the project by name, open or closed: its id and title; null when none had it */
export async function findAgentWindow(projectPath: string, name: string): Promise<AgentWindowMatch | null> {
  const open = projectWindows(projectPath).find((terminal) => agentSessionName(terminal.id) === name);
  if (open) return { terminalId: open.id, title: open.title, open: true };
  const session = await recordedSession(projectPath, name);
  if (!session?.terminalId) return null;
  return { terminalId: session.terminalId, title: await recordedTitle(projectPath, session), open: false };
}

/** Shells a window shows its prompt in: one of them in the foreground means nothing else runs */
const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh', 'powershell', 'cmd', 'wsl']);

/**
 * Whether a window's shell is what runs in its foreground (not vim, a dev server or another
 * program the resume command would be typed into); unknown counts as idle
 */
export function shellIsIdle(terminal: TerminalProcess): boolean {
  let foreground = '';
  try {
    foreground = terminal.pty?.process ?? '';
  } catch {
    return true;
  }
  const name = foreground.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').replace(/^-/, '').toLowerCase() ?? '';
  return !name || SHELLS.has(name);
}

/** Windows being opened, by name, so two messages to one closed window open it once */
const opening = new Map<string, Promise<boolean>>();

/**
 * Have the window a name stands for running Claude Code: a closed one is opened again on its last
 * session, an open one back at its shell resumes it. Resolves whether its Claude Code runs (false
 * when no window had the name, or it didn't start in time)
 */
export function ensureAgentWindowRunning(projectPath: string, name: string): Promise<boolean> {
  const open = projectWindows(projectPath).find((terminal) => agentSessionName(terminal.id) === name);
  if (open?.isCLIMode) return Promise.resolve(true);
  // Back at its shell, but running something else there: nothing is typed into it
  if (open && !shellIsIdle(open)) return Promise.resolve(false);
  const pending = opening.get(name);
  if (pending) return pending;
  const run = (async () => {
    const session = await recordedSession(projectPath, name);
    if (!session?.terminalId) return false;
    const terminalId = session.terminalId;
    // The Live agent graph shows the session in this window, which nobody has typed into
    noteWindowSession(session.sessionId, terminalId);
    opener({
      projectPath,
      terminalId,
      title: await recordedTitle(projectPath, session),
      sessionId: session.sessionId,
      configDir: session.configDir,
      cwd: await recordedCwd(projectPath, session),
    });
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, OPEN_POLL_MS));
      const terminal = findWindow(terminalId);
      if (terminal && (await windowLiveSession(terminal))) return true;
    }
    return false;
  })();
  opening.set(name, run);
  void run.finally(() => opening.delete(name));
  return run;
}

/**
 * The project's agent window a SendMessage name reaches (the name `claude agents` lists, which
 * `list_sessions` gives as `sendMessageTo`), or undefined
 */
export async function windowBySendMessageName(projectPath: string, sendMessageTo: string): Promise<string | undefined> {
  const windows = projectWindows(projectPath);
  const names = await Promise.all(windows.map((terminal) => windowLiveSession(terminal).then((live) => live?.name)));
  return windows[names.indexOf(sendMessageTo)]?.id;
}

/**
 * A chat's turn sent a message with SendMessage: the project's agent window it reaches (if any)
 * turns read-only until it has answered (receiving.ts)
 */
export async function windowMessaged(projectPath: string, sendMessageTo: string, from: SessionMessageOrigin): Promise<void> {
  const terminalId = await windowBySendMessageName(projectPath, sendMessageTo.trim());
  // A window that holds such messages for approval stays the user's: they answer the prompt
  if (terminalId && (await windowAcceptsMessages(terminalId))) startReceiving(terminalId, from);
}
