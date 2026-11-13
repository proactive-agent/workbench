/**
 * PTY Manager Module
 * Handles low-level PTY process creation and lifecycle
 */

import * as pty from '@lydell/node-pty';
import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import type { ShellKind, TerminalProcess, WindowGetter } from './types';
import { isWindows, getWindowsShellPaths, getPathDelimiter } from '../platform';
import { getWslInfo } from '../platform/shell-runtime';
import { buildWslPtyLaunch } from './wsl-terminal';
import { IPC_CHANNELS } from '../../shared/constants';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { projectAccount } from '../project-account';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import { withClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { noteTerminalWrite } from '../live-agent/terminal-activity';

// Windows shell paths are now imported from the platform module via getWindowsShellPaths()

/**
 * Shutdown flag to prevent PTY handlers from accessing destroyed resources
 * (e.g., BrowserWindow.webContents) during app shutdown.
 * Follows the same pattern as isShuttingDown in pty-daemon-client.ts.
 *
 * Part of the shutdown guard pattern for GitHub issue #1469: without this flag,
 * PTY onData/onExit callbacks can fire after BrowserWindow is destroyed,
 * causing pty.node's native ThreadSafeFunction to SIGABRT.
 */
let isShuttingDown = false;

/**
 * Set the shutting down flag. Call this during app quit/before-quit
 * to prevent PTY handlers from accessing destroyed resources.
 */
export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}

/**
 * Check if the PTY manager is in shutting down state.
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Result of spawning a PTY process
 */
export interface SpawnPtyResult {
  pty: pty.IPty;
  /** The shell's kind (decides the syntax of the commands typed into it) */
  shellKind: ShellKind;
  /** A WSL window whose login shell is fish: the lines the app types run through `bash -c` */
  wrapInBash?: boolean;
}

/**
 * Result of Windows shell detection
 */
interface WindowsShellResult {
  shell: string;
  shellKind: ShellKind;
  args: string[];
}

/**
 * Track pending exit promises for terminals being destroyed.
 * Used to wait for PTY process exit on Windows where termination is async.
 */
const pendingExitPromises = new Map<string, {
  resolve: () => void;
  timeoutId: NodeJS.Timeout;
}>();

/**
 * Default timeouts for waiting for PTY exit (in milliseconds).
 * Windows needs longer timeout due to slower process termination.
 */
const PTY_EXIT_TIMEOUT_WINDOWS = 2000;
const PTY_EXIT_TIMEOUT_UNIX = 500;

/**
 * Wait for a PTY process to exit.
 * Returns a promise that resolves when the PTY's onExit event fires.
 * Has a timeout fallback in case the exit event never fires.
 */
function waitForPtyExit(terminalId: string, timeoutMs?: number): Promise<void> {
  const timeout = timeoutMs ?? (isWindows() ? PTY_EXIT_TIMEOUT_WINDOWS : PTY_EXIT_TIMEOUT_UNIX);

  return new Promise<void>((resolve) => {
    // Set up timeout fallback
    const timeoutId = setTimeout(() => {
      debugLog('[PtyManager] PTY exit timeout for terminal:', terminalId);
      pendingExitPromises.delete(terminalId);
      resolve();
    }, timeout);

    // Store the promise resolver
    pendingExitPromises.set(terminalId, { resolve, timeoutId });
  });
}

/**
 * Determine a Windows shell's kind from its path: PowerShell 7 (pwsh.exe) and Windows PowerShell
 * 5.1 (powershell.exe) take PowerShell syntax, bash-style shells POSIX syntax, the rest (cmd.exe)
 * cmd.exe syntax.
 */
export function detectWindowsShellKind(shellPath: string): ShellKind {
  const filename = shellPath.split(/[/\\]/).pop()?.toLowerCase() || '';
  if (filename === 'pwsh.exe' || filename === 'pwsh' || filename === 'powershell.exe' || filename === 'powershell') {
    return 'powershell';
  }
  if (filename === 'bash.exe' || filename === 'sh.exe' || filename === 'zsh.exe') {
    return 'posix';
  }
  return 'cmd';
}

/** pwsh.exe in a folder on PATH (e.g. a winget, Store or scoop install outside Program Files) */
function findPwshOnPath(): string | null {
  for (const dir of (process.env.PATH || process.env.Path || '').split(getPathDelimiter())) {
    if (!dir.trim()) continue;
    const candidate = path.win32.join(dir.trim(), 'pwsh.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The PowerShell agent windows run on Windows: PowerShell 7 (pwsh.exe in Program Files, then on
 * PATH), else Windows PowerShell 5.1, which every Windows has. Only existsSync checks: nothing is
 * started to find it.
 */
export function findWindowsPowerShell(): string {
  const candidates = getWindowsShellPaths().powershell ?? [];
  const isPwsh = (shellPath: string) => /pwsh\.exe$/i.test(shellPath);

  const pwsh = candidates.find((shellPath) => isPwsh(shellPath) && existsSync(shellPath)) ?? findPwshOnPath();
  if (pwsh) return pwsh;

  const windowsPowerShell = candidates.find((shellPath) => !isPwsh(shellPath) && existsSync(shellPath));
  return windowsPowerShell ?? 'powershell.exe';
}

/**
 * The shell agent windows and terminals start on Windows.
 *
 * Native tools ('pwsh' runtime): PowerShell, whatever the hidden `preferredTerminal` setting says
 * (that setting only picks the external terminal for openTerminalWithCommand). `-NoLogo` hides the
 * banner. The user's PowerShell profile still loads, like in any terminal they open: the commands
 * the app types use only built-in cmdlets by their full names (Set-Location, Clear-Host,
 * Get-Content, Remove-Item), `$env:` and the call operator, which a profile's aliases and prompt
 * don't change, and keystrokes typed while the profile loads wait in the console's input buffer.
 *
 * The WSL runtime starts wsl.exe instead (see spawnPtyProcess and wsl-terminal.ts).
 */
function getWindowsShell(): WindowsShellResult {
  const shell = findWindowsPowerShell();
  return { shell, shellKind: detectWindowsShellKind(shell), args: ['-NoLogo'] };
}

/**
 * Spawn a new PTY process with appropriate shell and environment.
 *
 * In the WSL runtime the window runs the user's login shell inside the distribution
 * (`wsl.exe -d <distro> --cd <cwd inside WSL>`, shellKind 'posix'), with the variables the app adds
 * for the window passed through WSLENV (see wsl-terminal.ts). Callers wait for
 * whenShellRuntimeReady() first, so a window opened at startup doesn't start in the wrong runtime.
 */
export function spawnPtyProcess(
  cwd: string,
  cols: number,
  rows: number,
  profileEnv?: Record<string, string>
): SpawnPtyResult {
  // Create a clean environment without DEBUG to prevent Claude Code from
  // enabling debug mode when the Electron app is run in development mode.
  // Also remove ANTHROPIC_API_KEY to ensure Claude Code uses OAuth tokens
  // (CLAUDE_CODE_OAUTH_TOKEN from profileEnv) instead of API keys that may
  // be present in the shell environment. Without this, Claude Code would
  // show "Claude API" instead of "Claude Max" when ANTHROPIC_API_KEY is set.
  // Remove CLAUDECODE to allow launching Claude Code inside agent terminals —
  // without this, inherited CLAUDECODE triggers the nested session guard.
  // (In WSL, a key the user's rc files export is removed by the `env -u` the claude command starts with.)
  const { DEBUG: _DEBUG, ANTHROPIC_API_KEY: _ANTHROPIC_API_KEY, CLAUDECODE: _CLAUDECODE, ...cleanEnv } = process.env;

  // Claude Code's default ~/.claude runs without CLAUDE_CONFIG_DIR
  const env = withClaudeConfigDir({
    ...cleanEnv,
    ...profileEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Suppress zsh's partial line indicator (%) that appears when output
    // doesn't end with a newline. This prevents rendering artifacts in the terminal.
    PROMPT_EOL_MARK: '',
  });

  const wslInfo = isWindows() ? getWslInfo() : null;
  if (wslInfo) {
    const launch = buildWslPtyLaunch(cwd, env, wslInfo, os.homedir());
    debugLog('[PtyManager] Spawning WSL shell:', launch.file, launch.args, '(login shell:', wslInfo.loginShell, ')');
    const ptyProcess = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: launch.cwd,
      env: launch.env,
    });
    return { pty: ptyProcess, shellKind: 'posix', ...(launch.wrapInBash ? { wrapInBash: true } : {}) };
  }

  let shell: string;
  let shellKind: ShellKind;
  let shellArgs: string[];

  if (isWindows()) {
    const windowsShell = getWindowsShell();
    shell = windowsShell.shell;
    shellKind = windowsShell.shellKind;
    shellArgs = windowsShell.args;
  } else {
    shell = process.env.SHELL || '/bin/zsh';
    shellKind = 'posix';
    shellArgs = ['-l'];
  }

  debugLog('[PtyManager] Spawning shell:', shell, shellArgs, '(shellKind:', shellKind, ')');
  debugLog('[PtyManager] PTY dimensions requested - cols:', cols, 'rows:', rows, 'cwd:', cwd || os.homedir());

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || os.homedir(),
    env,
  });

  return { pty: ptyProcess, shellKind };
}

/**
 * Setup PTY event handlers for a terminal process
 */
export function setupPtyHandlers(
  terminal: TerminalProcess,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  onDataCallback: (terminal: TerminalProcess, data: string) => void,
  onExitCallback: (terminal: TerminalProcess) => void
): void {
  const { id, pty: ptyProcess } = terminal;
  terminal.hasExited = false;

  // Handle data from terminal
  ptyProcess.onData((data) => {
    // Shutdown guard (GitHub #1469): skip processing to avoid accessing
    // destroyed BrowserWindow.webContents, which triggers pty.node SIGABRT
    if (isShuttingDown) return;
    if (terminal.hasExited) return;
    // A destroyed PTY (removed from the map, e.g. when a terminal moves to another worktree)
    // can still flush output while it dies; it must not reach the replacement terminal
    // that reuses its id
    if (terminals.get(id) !== terminal) return;
    // Following a running task's session: the window shows the session, not the idle shell
    if (terminal.follower) return;

    // Append to output buffer (limit to 100KB)
    terminal.outputBuffer = (terminal.outputBuffer + data).slice(-100000);

    // Call custom data handler. This must never crash the main process:
    // parser logic in higher layers can throw on unexpected output.
    try {
      onDataCallback(terminal, data);
    } catch (error) {
      debugError('[PtyManager] onData callback failed for terminal:', id, 'error:', error);
    }

    // Send to renderer with isDestroyed() check to prevent crashes
    // when the window is closed during terminal activity
    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, id, data);
  });

  // Handle terminal exit
  ptyProcess.onExit(({ exitCode }) => {
    terminal.hasExited = true;
    // Drop any queued writes for this terminal to avoid writing to dead PTYs.
    pendingWrites.delete(id);
    debugLog('[PtyManager] Terminal exited:', id, 'code:', exitCode);

    // Always resolve pending exit promises, even during shutdown
    // (needed for waitForPtyExit callers to complete)
    const pendingExit = pendingExitPromises.get(id);
    if (pendingExit) {
      clearTimeout(pendingExit.timeoutId);
      pendingExitPromises.delete(id);
      pendingExit.resolve();
    }

    // Shutdown guard (GitHub #1469): skip accessing win.webContents and callbacks
    // to avoid pty.node SIGABRT from destroyed BrowserWindow resources
    if (isShuttingDown) return;

    // Send to renderer with isDestroyed() check to prevent crashes
    // when the window is closed during terminal exit. Skip PTYs that were deliberately
    // destroyed: their exit can arrive after a replacement terminal with the same id
    // started (worktree switch), and would mark that live terminal as exited
    if (terminals.get(id) === terminal) {
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_EXIT, id, exitCode);
    }

    // Call custom exit handler. Guard against unexpected exceptions so PTY exit
    // handling remains robust and doesn't take down the main process.
    try {
      onExitCallback(terminal);
    } catch (error) {
      debugError('[PtyManager] onExit callback failed for terminal:', id, 'error:', error);
    }

    // Only delete if this is the SAME terminal object (not a newly created one with same ID).
    // This prevents a race where destroyTerminal() awaits PTY exit, a new terminal is created
    // with the same ID during the await, and then the old PTY's onExit deletes the new terminal.
    if (terminals.get(id) === terminal) {
      terminals.delete(id);
    }
  });
}

/**
 * Constants for chunked write behavior
 * CHUNKED_WRITE_THRESHOLD: Data larger than this (bytes) will be written in chunks.
 *   Set high enough that typical pastes go through as a single synchronous write.
 * CHUNK_SIZE: Size of each chunk. Larger chunks = fewer event-loop yields = less
 *   GPU pressure when many terminals are rendering simultaneously.
 *   Previous values (1000/100) caused GPU context exhaustion: a 9KB paste produced
 *   ~91 setImmediate yields, letting GPU rendering tasks from 8+ terminals pile up
 *   until ContextResult::kTransientFailure crashed the app.
 */
const CHUNKED_WRITE_THRESHOLD = 16_384;
const CHUNK_SIZE = 8_192;

/**
 * Write queue per terminal to prevent interleaving of concurrent writes.
 * Maps terminal ID to the last write Promise in the queue.
 */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Internal function to perform the actual write (chunked or direct)
 * Returns a Promise that resolves when the write is complete
 */
function performWrite(terminal: TerminalProcess, data: string): Promise<void> {
  return new Promise((resolve) => {
    if (terminal.hasExited) {
      resolve();
      return;
    }

    // For large commands, write in chunks to prevent blocking
    if (data.length > CHUNKED_WRITE_THRESHOLD) {
      debugLog('[PtyManager:writeToPty] Large write detected, using chunked write');
      let offset = 0;
      let chunkNum = 0;

      const writeChunk = () => {
        // Check if terminal is still valid before writing
        if (!terminal.pty || terminal.hasExited) {
          debugError('[PtyManager:writeToPty] Terminal PTY no longer valid, aborting chunked write');
          resolve();
          return;
        }

        if (offset >= data.length) {
          debugLog('[PtyManager:writeToPty] Chunked write completed, total chunks:', chunkNum);
          resolve();
          return;
        }

        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        chunkNum++;
        try {
          terminal.pty.write(chunk);
          offset += CHUNK_SIZE;
          // Use setImmediate to yield to the event loop between chunks
          setImmediate(writeChunk);
        } catch (error) {
          debugError('[PtyManager:writeToPty] Chunked write FAILED at chunk', chunkNum, ':', error);
          resolve(); // Resolve anyway - fire-and-forget semantics
        }
      };

      // Start the chunked write after yielding
      setImmediate(writeChunk);
    } else {
      try {
        terminal.pty.write(data);
        debugLog('[PtyManager:writeToPty] Write completed successfully');
      } catch (error) {
        debugError('[PtyManager:writeToPty] Write FAILED:', error);
      }
      resolve();
    }
  });
}

/**
 * Write data to a PTY process
 * Uses setImmediate to prevent blocking the event loop on large writes.
 * Serializes writes per terminal to prevent interleaving of concurrent writes.
 */
export function writeToPty(terminal: TerminalProcess, data: string): void {
  debugLog('[PtyManager:writeToPty] About to write to pty, data length:', data.length);
  if (terminal.hasExited) {
    debugError('[PtyManager:writeToPty] Skipping write to exited terminal:', terminal.id);
    return;
  }
  // Live agent tells which window a Claude Code session belongs to by which one was last used
  noteTerminalWrite(terminal.id);

  // Get the previous write Promise for this terminal (if any)
  const previousWrite = pendingWrites.get(terminal.id) || Promise.resolve();

  // Chain this write after the previous one completes
  const currentWrite = previousWrite.then(() => performWrite(terminal, data));

  // Update the pending write for this terminal
  pendingWrites.set(terminal.id, currentWrite);

  // Clean up the Map entry when done to prevent memory leaks
  currentWrite.finally(() => {
    // Only clean up if this is still the latest write
    if (pendingWrites.get(terminal.id) === currentWrite) {
      pendingWrites.delete(terminal.id);
    }
  });
}

/**
 * Resize a PTY process with validation and error handling.
 * @param terminal The terminal process to resize
 * @param cols New column count
 * @param rows New row count
 * @returns true if resize was successful, false otherwise
 */
/**
 * How long a same-size resize keeps the PTY one column narrower: the program must see that size
 * before the real one comes back. Node reads the size when it handles SIGWINCH, so two resizes in
 * a row reach Claude Code as one, at the size it already had, and it never redraws
 */
const SIGWINCH_CYCLE_MS = 200;
/** The PTYs waiting to get their size back after a same-size resize, by terminal id */
const pendingSizeRestores = new Map<string, ReturnType<typeof setTimeout>>();

export function resizePty(terminal: TerminalProcess, cols: number, rows: number): boolean {
  // A newer size replaces the one a same-size resize was about to restore
  const pending = pendingSizeRestores.get(terminal.id);
  if (pending) {
    clearTimeout(pending);
    pendingSizeRestores.delete(terminal.id);
  }
  if (terminal.hasExited) {
    debugError('[PtyManager] Resize skipped for exited terminal:', terminal.id);
    return false;
  }

  // Validate dimensions
  if (cols <= 0 || rows <= 0 || !Number.isFinite(cols) || !Number.isFinite(rows)) {
    debugError('[PtyManager] Invalid resize dimensions - terminal:', terminal.id, 'cols:', cols, 'rows:', rows);
    return false;
  }

  try {
    const prevCols = terminal.pty.cols;
    const prevRows = terminal.pty.rows;

    // If dimensions are unchanged, force SIGWINCH via a resize cycle.
    // On macOS/Linux, ioctl(TIOCSWINSZ) only sends SIGWINCH when size actually
    // changes. This matters after project switch: PTY persists with old dimensions,
    // terminal remounts at same size, TUI apps (Claude Code) never get SIGWINCH
    // and never redraw — leaving the terminal blank.
    // The narrower size and the real one are set apart (SIGWINCH_CYCLE_MS), so Claude Code sees
    // both and redraws (a window shown again after the Projects page stayed blank otherwise)
    if (prevCols === cols && prevRows === rows && cols > 1) {
      debugLog('[PtyManager] Same-dimension resize detected, forcing SIGWINCH cycle for terminal:', terminal.id);
      terminal.pty.resize(cols - 1, rows);
      pendingSizeRestores.set(terminal.id, setTimeout(() => {
        pendingSizeRestores.delete(terminal.id);
        if (terminal.hasExited) return;
        try {
          terminal.pty.resize(cols, rows);
        } catch (error) {
          debugError('[PtyManager] Size restore failed for terminal:', terminal.id, 'error:', error);
        }
      }, SIGWINCH_CYCLE_MS));
      return true;
    }

    debugLog('[PtyManager] Resizing PTY - terminal:', terminal.id, 'from:', prevCols, 'x', prevRows, 'to:', cols, 'x', rows);
    terminal.pty.resize(cols, rows);
    debugLog('[PtyManager] PTY resized - actual dimensions now:', terminal.pty.cols, 'x', terminal.pty.rows);
    return true;
  } catch (error) {
    debugError('[PtyManager] Resize failed for terminal:', terminal.id, 'error:', error);
    return false;
  }
}

/**
 * Kill a PTY process.
 * @param terminal The terminal process to kill
 * @param waitForExit If true, returns a promise that resolves when the PTY exits.
 *                    Used on Windows where PTY termination is async.
 */
export function killPty(terminal: TerminalProcess, waitForExit: true): Promise<void>;
export function killPty(terminal: TerminalProcess, waitForExit?: false): void;
export function killPty(terminal: TerminalProcess, waitForExit?: boolean): Promise<void> | void {
  if (terminal.hasExited) {
    return waitForExit ? Promise.resolve() : undefined;
  }

  if (waitForExit) {
    const exitPromise = waitForPtyExit(terminal.id);
    try {
      terminal.pty.kill();
    } catch (error) {
      // Clean up the pending promise if kill() throws
      const pending = pendingExitPromises.get(terminal.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingExitPromises.delete(terminal.id);
        pending.resolve();
      }
      throw error;
    }
    return exitPromise;
  }
  terminal.pty.kill();
}

/**
 * The Claude account environment a window starts with: its project's own account (`projectPath`),
 * else the account in use
 */
export function getActiveProfileEnv(projectPath?: string): Record<string, string> {
  const profileManager = getClaudeProfileManager();
  const own = projectAccount(profileManager, projectPath);
  return own ? profileManager.getProfileEnv(own.id) : profileManager.getActiveProfileEnv();
}
