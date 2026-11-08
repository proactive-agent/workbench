/**
 * Which live Claude Code session an agent window runs, and the name Claude Code's SendMessage
 * reaches it by. `claude agents --json` lists the running sessions (pid, session id, name); a
 * window is matched by the session Workbench last started or resumed in it, else (natively on
 * Linux and macOS, after `/clear` or `/resume` changed the session) by the Claude Code process
 * running under the window's shell.
 */
import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getToolInfoAsync } from '../cli-tool-manager';
import { runTool } from '../platform/runtime-exec';
import { isWslRuntime } from '../platform/shell-runtime';
import { isLinux, isMacOS } from '../platform';
import { lastAgentSession } from '../agent-session-store';
import type { TerminalProcess } from '../terminal/types';
import { expandClaudeHome } from '../platform/claude-home';
import { withClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { getClaudeProfileManager } from '../claude-profile-manager';

const execFileAsync = promisify(execFile);

/** A running Claude Code session, as `claude agents --json` lists it */
export interface LiveClaudeSession {
  pid?: number;
  cwd?: string;
  sessionId?: string;
  name?: string;
  kind?: string;
  status?: string;
}

/** How long one listing is reused (several windows are looked up for one tool call) */
const CACHE_MS = 3000;
const cache = new Map<string, { at: number; sessions: Promise<LiveClaudeSession[]> }>();

/**
 * The running Claude Code sessions on this machine (in WSL mode, in the distribution), as the
 * account of `configDir` lists them (Claude Code's default ~/.claude when unset)
 */
export function liveClaudeSessions(configDir?: string): Promise<LiveClaudeSession[]> {
  const key = configDir ?? '';
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.sessions;
  const sessions = (async () => {
    const claude = await getToolInfoAsync('claude');
    if (!claude.found || !claude.path) return [];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (configDir) env.CLAUDE_CONFIG_DIR = expandClaudeHome(configDir);
    const { stdout } = await runTool('claude', ['agents', '--json'], {
      command: claude.path,
      env: withClaudeConfigDir(env),
      encoding: 'utf-8',
      timeout: 15_000,
    });
    const parsed = JSON.parse(String(stdout)) as unknown;
    return Array.isArray(parsed) ? (parsed as LiveClaudeSession[]) : [];
  })().catch(() => [] as LiveClaudeSession[]);
  cache.set(key, { at: Date.now(), sessions });
  return sessions;
}

/** The config dir of the account a window runs on: its recorded session's, else its profile's */
function windowConfigDir(terminal: TerminalProcess, recordedConfigDir: string | undefined): string | undefined {
  if (recordedConfigDir) return recordedConfigDir;
  try {
    const manager = getClaudeProfileManager();
    const profile = terminal.claudeProfileId ? manager.getProfile(terminal.claudeProfileId) : manager.getActiveProfile();
    return profile?.configDir;
  } catch {
    return undefined;
  }
}

/** A process's parent: /proc on Linux, `ps` on macOS */
async function parentPid(pid: number): Promise<number | null> {
  try {
    if (isLinux()) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
      // The name (in parentheses) may hold spaces: the fields after it are fixed
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return ppid > 0 ? ppid : null;
    }
    if (isMacOS()) {
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 3000 });
      const ppid = Number(stdout.trim());
      return ppid > 0 ? ppid : null;
    }
  } catch {
    // Gone, or unreadable
  }
  return null;
}

/** Whether `pid` runs under `ancestor` (a few levels: shell, maybe a wrapper, then Claude Code) */
async function runsUnder(pid: number, ancestor: number): Promise<boolean> {
  let current: number | null = pid;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current === ancestor) return true;
    current = await parentPid(current);
  }
  return false;
}

/** The live Claude Code session of an agent window, or undefined when none is found */
export async function windowLiveSession(terminal: TerminalProcess): Promise<LiveClaudeSession | undefined> {
  if (!terminal.isCLIMode) return undefined;
  const own = terminal.projectPath ? await lastAgentSession(terminal.projectPath, terminal.id).catch(() => undefined) : undefined;
  const recorded = own?.sessionId;
  // Listed as the window's account sees its sessions
  const sessions = (await liveClaudeSessions(windowConfigDir(terminal, own?.configDir))).filter((session) => session.kind !== 'background');
  const byId = recorded ? sessions.filter((session) => session.sessionId === recorded) : [];
  if (byId.length === 1) return byId[0];
  // The process tree is only readable natively (in WSL the window's process is wsl.exe)
  const shellPid = terminal.pty?.pid;
  if (!shellPid || isWslRuntime() || !(isLinux() || isMacOS())) return byId[0];
  // Several processes may run the recorded session (another window resumed it, or a closed window's
  // Claude Code was left running): the one under this window's shell is the window's
  for (const session of byId.length > 1 ? byId : sessions) {
    if (session.pid && (await runsUnder(session.pid, shellPid))) return session;
  }
  return byId[0];
}

/**
 * Forget the cached listing (tests)
 * @internal
 */
export function resetLiveSessionsCache(): void {
  cache.clear();
}
