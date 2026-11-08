/**
 * The Claude Code sessions of a project
 *
 * An agent window runs Claude Code in a PTY, so no task directory records what it spends. Every
 * window Workbench starts gets a session id of its own (`claude --session-id`), and the ids are
 * kept here, in the project's own `.workbench/agent-sessions.json`, so Metrics can still read what
 * those sessions cost from Claude Code's transcripts long after the window is closed. A restored
 * window records the session it picks up as well, including a conversation that was already going
 * before Workbench recorded any (`cli-integration-handler.ts`), so what it has spent on earlier
 * days is counted too, on those days.
 *
 * Metrics also finds the project's other Claude Code sessions - Insights, and `claude` run in a
 * terminal - by the directory they ran in (`claude-code/project-sessions.ts`) and adds them here
 * when it first sees them, so they are read once and then only when their transcript changes.
 *
 * Nothing is ever dropped from the file: Metrics adds up what it holds on every refresh, so
 * forgetting a session would make the project's reported spending fall. Sessions whose transcript
 * has not changed keep the spending read from it last time, so a refresh reads only what is new.
 *
 * The file lives in the project, so it holds that project's windows only. Writes are serialized
 * per file (several windows can start at once), go through a temp file, and never run when the
 * project has no `.workbench` directory - that directory is what marks a project initialized.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { appLog } from './app-logger';
import { isNodeError } from './utils/type-guards';

/** What a session had spent when its transcript was last read */
export interface AgentSessionSpending {
  totalCostUsd: number;
  /** Local calendar day (`YYYY-MM-DD`) to what the session spent that day */
  days: Record<string, number>;
  /** The transcript it was read from, and its size and mtime, so an unchanged file is not re-read */
  transcript: string;
  size: number;
  modifiedMs: number;
  /**
   * What reconciling the whole project needs on top of the scaled figures above, which it cannot be
   * worked out from: one cost accounting's total reaches every transcript it touched, so it has to
   * be recognized across them rather than added up (`project-metrics.ts`). These are optional
   * because a store written before they were kept holds only the two figures above.
   */
  /** The turns priced per model, before they were scaled to what the accountings reported */
  estimate?: { days: Record<string, number>; total: number; undated: number };
  /** Day of the transcript's last record, where turns with no day of their own are booked */
  lastDay?: string | null;
  /** Highest total each cost accounting reported in this transcript, by its `runKey()` */
  runs?: Record<string, number>;
}

/** One Claude Code session an agent window started */
export interface AgentSessionRecord {
  /** Claude Code session id, the name of its transcript */
  sessionId: string;
  /** Config dir the session was started on (where Claude Code writes its transcript) */
  configDir?: string;
  /** Working directory it was started in, which names the transcript's folder */
  cwd?: string;
  /** The window that started it */
  terminalId?: string;
  /** When the window started it (ISO) */
  startedAt: string;
  /** What it had spent when its transcript was last read */
  spent?: AgentSessionSpending;
}

interface AgentSessionData {
  sessions: AgentSessionRecord[];
}

/** Writes in flight per file, so two windows starting at once can't lose each other's session */
const writes = new Map<string, Promise<void>>();

function storePath(projectPath: string): string {
  return path.join(projectPath, '.workbench', 'agent-sessions.json');
}

/** The sessions on file, or null when the project has none to read */
async function loadSessions(file: string): Promise<AgentSessionRecord[] | null> {
  let contents: string;
  try {
    contents = await fsp.readFile(file, 'utf-8');
  } catch (error) {
    // No window has run Claude Code in this project yet
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    appLog.warn(`[AgentSessionStore] Could not read ${file}:`, error);
    return null;
  }
  try {
    const data = JSON.parse(contents) as Partial<AgentSessionData>;
    if (!Array.isArray(data.sessions)) return null;
    return data.sessions.filter((session) => typeof session?.sessionId === 'string' && session.sessionId);
  } catch (error) {
    appLog.warn(`[AgentSessionStore] Could not make sense of ${file}:`, error);
    return null;
  }
}

/** The sessions this project's agent windows started, oldest first */
export async function readAgentSessions(projectPath: string): Promise<AgentSessionRecord[]> {
  return (await loadSessions(storePath(projectPath))) ?? [];
}

/**
 * Rewrite the project's sessions. A file that is there but unreadable is left alone: its sessions
 * are this project's only record of what its windows spent.
 */
async function updateSessions(
  projectPath: string,
  change: (sessions: AgentSessionRecord[]) => AgentSessionRecord[]
): Promise<void> {
  const file = storePath(projectPath);
  const write = (writes.get(file) ?? Promise.resolve()).then(async () => {
    // `.workbench` marks a project as initialized, so this never creates it
    if (!(await isDirectory(path.dirname(file)))) return;

    const sessions = await loadSessions(file);
    if (sessions === null) return;
    const next = change(sessions);
    const data: AgentSessionData = { sessions: next };

    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(temp, file);
  });
  writes.set(file, write.catch(() => undefined));
  await write;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The window each session was last started or resumed in, while the app runs (newest last) */
const sessionWindows = new Map<string, string>();
const MAX_SESSION_WINDOWS = 500;

/** A window started or resumed this session (the Live agent graph shows it in that window) */
export function noteWindowSession(sessionId: string, terminalId: string): void {
  sessionWindows.delete(sessionId);
  sessionWindows.set(sessionId, terminalId);
  if (sessionWindows.size > MAX_SESSION_WINDOWS) sessionWindows.delete(sessionWindows.keys().next().value!);
}

/** The window that last started or resumed a session since the app started, if any */
export function windowOfSession(sessionId: string): string | undefined {
  return sessionWindows.get(sessionId);
}

/** Remember a session an agent window just started; a session already known is updated in place */
export async function recordAgentSession(projectPath: string, session: AgentSessionRecord): Promise<void> {
  if (session.terminalId) noteWindowSession(session.sessionId, session.terminalId);
  await updateSessions(projectPath, (sessions) => [
    ...sessions.filter((kept) => kept.sessionId !== session.sessionId),
    { ...sessions.find((kept) => kept.sessionId === session.sessionId), ...session },
  ]);
}

/**
 * Add the sessions of a project that were found rather than started by a window. A session already
 * on file is left as it is, keeping what was read from its transcript.
 */
export async function recordFoundSessions(projectPath: string, sessions: AgentSessionRecord[]): Promise<void> {
  if (sessions.length === 0) return;
  await updateSessions(projectPath, (known) => {
    const ids = new Set(known.map((session) => session.sessionId));
    return [...known, ...sessions.filter((session) => !ids.has(session.sessionId))];
  });
}

/** Remember a session without making the caller wait for the disk; failures are only logged */
export function recordAgentSessionAsync(projectPath: string, session: AgentSessionRecord): void {
  void recordAgentSession(projectPath, session).catch((error) => {
    appLog.warn('[AgentSessionStore] Could not record an agent window session:', error);
  });
}

/**
 * The session this window last started, so restoring the window can pick its own session up again
 * instead of whatever Claude Code session in the directory was written to last.
 */
export async function lastAgentSession(
  projectPath: string,
  terminalId: string
): Promise<AgentSessionRecord | undefined> {
  const sessions = await readAgentSessions(projectPath);
  return sessions.filter((session) => session.terminalId === terminalId).pop();
}

/** Keep what reading the transcripts just cost, so the next refresh only reads what changed */
export async function cacheAgentSessionSpending(
  projectPath: string,
  spending: Map<string, AgentSessionSpending>
): Promise<void> {
  if (spending.size === 0) return;
  await updateSessions(projectPath, (sessions) =>
    sessions.map((session) => {
      const spent = spending.get(session.sessionId);
      return spent ? { ...session, spent } : session;
    })
  );
}
