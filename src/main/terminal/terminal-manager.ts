/**
 * Terminal Manager
 * Main orchestrator for terminal lifecycle, Claude integration, and profile management
 */

import type { ClaudeSessionItem, TerminalCreateOptions } from '../../shared/types';
import type { TerminalSession } from '../terminal-session-store';

// Internal modules
import type {
  TerminalProcess,
  WindowGetter,
  TerminalOperationResult,
  TerminalProfileChangeInfo,
} from './types';
import * as PtyManager from './pty-manager';
import * as SessionHandler from './session-handler';
import * as TerminalLifecycle from './terminal-lifecycle';
import * as TerminalEventHandler from './terminal-event-handler';
import * as ClaudeIntegration from './cli-integration-handler';
import { SessionFollower, type FollowedRun } from './session-follower';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import { SESSION_SAVE_INTERVAL_MS } from '../terminal-session-store';

export class TerminalManager {
  private terminals: Map<string, TerminalProcess> = new Map();
  private getWindow: WindowGetter;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastNotifiedRateLimitReset: Map<string, string> = new Map();
  private eventCallbacks: TerminalEventHandler.EventHandlerCallbacks;

  constructor(getWindow: WindowGetter) {
    this.getWindow = getWindow;

    // Create event callbacks with bound context
    this.eventCallbacks = TerminalEventHandler.createEventCallbacks(
      this.getWindow,
      this.lastNotifiedRateLimitReset,
      async (terminalId, profileId) => {
        await this.switchClaudeProfile(terminalId, profileId);
      }
    );

    // Periodically save session data. The period is shared with the store, which reads the trail
    // these saves leave to tell a run that is still going from one that is gone
    this.saveTimer = setInterval(() => {
      SessionHandler.persistAllSessionsAsync(this.terminals).catch((error) => {
        console.error('[TerminalManager] Failed to persist sessions:', error);
      });
    }, SESSION_SAVE_INTERVAL_MS);
  }

  /**
   * Create a new terminal process
   */
  async create(
    options: TerminalCreateOptions & { projectPath?: string }
  ): Promise<TerminalOperationResult> {
    return TerminalLifecycle.createTerminal(
      options,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data)
    );
  }

  /**
   * Restore a terminal session
   */
  async restore(
    session: TerminalSession,
    cols = 80,
    rows = 24
  ): Promise<TerminalOperationResult> {
    return TerminalLifecycle.restoreTerminal(
      session,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data),
      {
        resumeClaudeSession: true,
        onResumeNeeded: (terminalId) => {
          // Use async version to avoid blocking main process
          this.resumeClaudeAsync(terminalId).catch((error) => {
            debugError('[terminal-manager] Failed to resume Claude session:', error);
          });
        }
      },
      cols,
      rows
    );
  }

  /**
   * Destroy a terminal process
   */
  async destroy(id: string): Promise<TerminalOperationResult> {
    this.stopFollowing(id);
    return TerminalLifecycle.destroyTerminal(
      id,
      this.terminals,
      (terminalId) => {
        this.lastNotifiedRateLimitReset.delete(terminalId);
      }
    );
  }

  /**
   * Kill all terminal processes
   */
  async killAll(): Promise<void> {
    for (const id of this.terminals.keys()) this.stopFollowing(id);
    this.saveTimer = await TerminalLifecycle.destroyAllTerminals(
      this.terminals,
      this.saveTimer
    );
  }

  /**
   * Send input to a terminal
   */
  write(id: string, data: string): void {
    debugLog('[TerminalManager:write] Writing to terminal:', id, 'data length:', data.length);
    const terminal = this.terminals.get(id);
    if (terminal?.follower) {
      // Following a running task's session: the follower handles the keys (Enter, Ctrl+C)
      terminal.follower.handleInput(data);
      return;
    }
    if (terminal) {
      debugLog('[TerminalManager:write] Terminal found, calling writeToPty...');
      PtyManager.writeToPty(terminal, data);
      debugLog('[TerminalManager:write] writeToPty completed');
    } else {
      debugError('[TerminalManager:write] Terminal NOT found:', id);
    }
  }

  /**
   * Resize a terminal
   * @returns true if resize was successful, false otherwise
   */
  resize(id: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return false;
    }
    return PtyManager.resizePty(terminal, cols, rows);
  }

  /**
   * Invoke Claude in a terminal with optional profile override (async - non-blocking)
   */
  async invokeCLIAsync(id: string, cwd?: string, profileId?: string, dangerouslySkipPermissions?: boolean): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    await ClaudeIntegration.invokeCLIAsync(
      terminal,
      cwd,
      profileId,
      this.getWindow,
      dangerouslySkipPermissions
    );
  }

  /**
   * Resume a task's Claude Code session in a terminal (`claude --resume <id>` in the task's
   * worktree), on the profile and config dir the session ran on (async - non-blocking)
   */
  async resumeTaskSessionAsync(
    id: string,
    options: { sessionId: string; cwd: string; profileId?: string; configDir?: string },
    dangerouslySkipPermissions?: boolean
  ): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    await ClaudeIntegration.invokeCLIAsync(
      terminal,
      options.cwd,
      options.profileId,
      this.getWindow,
      dangerouslySkipPermissions,
      { resumeSessionId: options.sessionId, configDir: options.configDir }
    );
  }

  /**
   * Follow a running task's Claude Code session in a terminal (read-only). Once the task stops,
   * Enter resumes the session there like resumeTaskSessionAsync.
   */
  followTaskSession(
    id: string,
    options: { sessionId: string; cwd: string; profileId?: string; configDir?: string },
    run: FollowedRun,
    dangerouslySkipPermissions?: boolean
  ): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.stopFollowing(id);
    // Output goes to this terminal only while it is still the one with this id (a recreated
    // window reuses the id)
    const write = (data: string) => {
      if (this.terminals.get(id) !== terminal) return;
      terminal.outputBuffer = (terminal.outputBuffer + data).slice(-100000);
      safeSendToRenderer(this.getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, id, data);
    };
    const follower = new SessionFollower({
      ...options,
      run,
      write,
      onContinue: (session) => {
        terminal.follower = undefined;
        this.resumeTaskSessionAsync(id, { ...session, cwd: options.cwd }, dangerouslySkipPermissions).catch((error) => {
          debugError('[TerminalManager] Failed to resume the followed session:', error);
        });
      },
      onRelease: () => {
        terminal.follower = undefined;
        terminal.isCLIMode = false;
        // A fresh prompt (the shell's output was held back while following)
        PtyManager.writeToPty(terminal, '\r');
      },
    });
    terminal.follower = follower;
    follower.start();
  }

  private stopFollowing(id: string): void {
    const terminal = this.terminals.get(id);
    terminal?.follower?.stop();
    if (terminal) terminal.follower = undefined;
  }

  /**
   * Invoke Claude in a terminal with optional profile override
   * @deprecated Use invokeCLIAsync for non-blocking behavior
   */
  invokeClaude(id: string, cwd?: string, profileId?: string, dangerouslySkipPermissions?: boolean): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    ClaudeIntegration.invokeClaude(
      terminal,
      cwd,
      profileId,
      this.getWindow,
      dangerouslySkipPermissions
    );
  }

  /**
   * Switch a terminal to a different Claude profile
   */
  async switchClaudeProfile(id: string, profileId: string): Promise<TerminalOperationResult> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return { success: false, error: 'Terminal not found' };
    }

    return ClaudeIntegration.switchClaudeProfile(
      terminal,
      profileId,
      this.getWindow,
      async (terminalId, cwd, profileId, dangerouslySkipPermissions) => this.invokeCLIAsync(terminalId, cwd, profileId, dangerouslySkipPermissions),
      (terminalId) => this.lastNotifiedRateLimitReset.delete(terminalId)
    );
  }

  /**
   * Resume Claude in a terminal asynchronously (non-blocking)
   */
  async resumeClaudeAsync(id: string, options?: { dangerouslySkipPermissions?: boolean }): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    // A terminal recreated after a profile swap is new, so the renderer passes the YOLO mode the
    // session had
    if (options?.dangerouslySkipPermissions !== undefined) {
      terminal.dangerouslySkipPermissions = options.dangerouslySkipPermissions;
    }

    await ClaudeIntegration.resumeClaudeAsync(terminal, this.getWindow);
  }

  /** The Claude Code sessions an agent window can open (what `/resume` lists there) */
  async listClaudeSessions(id: string): Promise<ClaudeSessionItem[]> {
    const terminal = this.terminals.get(id);
    return terminal ? ClaudeIntegration.listWindowSessions(terminal) : [];
  }

  /** End an agent window's Claude Code session and open another one, or a new one (null) */
  async openClaudeSession(id: string, sessionId: string | null, dangerouslySkipPermissions?: boolean): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Terminal not found');
    await ClaudeIntegration.openWindowSession(terminal, sessionId, this.getWindow, dangerouslySkipPermissions);
  }

  /**
   * Continue an agent window's own Claude Code session on another account, in place (same shell,
   * id and place in the grid)
   */
  async moveAgentWindowToAccount(id: string, profileId: string, configDir: string | undefined): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.claudeProfileId = profileId;
    await ClaudeIntegration.moveAgentWindowToAccount(terminal, configDir, this.getWindow);
  }

  /**
   * Activate deferred Claude resume for a terminal
   * Called by the renderer once a terminal with pendingCLIResume is shown
   */
  async activateDeferredResume(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    // Check if terminal has a pending resume
    if (!terminal.pendingCLIResume) {
      return;
    }

    // Clear the pending flag
    terminal.pendingCLIResume = false;

    // Now actually resume Claude
    await ClaudeIntegration.resumeClaudeAsync(terminal, this.getWindow);
  }

  /**
   * Resume Claude in a terminal (its project's latest session)
   * @deprecated Use resumeClaudeAsync for non-blocking behavior
   */
  resumeClaude(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    ClaudeIntegration.resumeClaude(terminal, this.getWindow);
  }

  /**
   * Get saved sessions for a project
   */
  getSavedSessions(projectPath: string): TerminalSession[] {
    return SessionHandler.getSavedSessions(projectPath);
  }

  /**
   * Clear saved sessions for a project
   */
  clearSavedSessions(projectPath: string): void {
    SessionHandler.clearSavedSessions(projectPath);
  }

  /**
   * Update display orders for terminals after drag-drop reorder
   */
  updateDisplayOrders(
    projectPath: string,
    orders: Array<{ terminalId: string; displayOrder: number }>
  ): void {
    SessionHandler.updateDisplayOrders(projectPath, orders);
  }

  /**
   * Get all active terminal IDs
   */
  getActiveTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Get a terminal by ID (for debugging/inspection)
   */
  getTerminal(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }

  /**
   * Check if a terminal is in Claude mode
   */
  isCLIMode(id: string): boolean {
    const terminal = this.terminals.get(id);
    return terminal?.isCLIMode ?? false;
  }

  /**
   * The windows to restart on the new account when the Claude account changes: agent windows
   * running Claude Code. Plain terminals keep their shell, and a window following a task's run
   * read-only keeps following (the run has its own account).
   */
  getTerminalsForProfileChange(): TerminalProfileChangeInfo[] {
    const result: TerminalProfileChangeInfo[] = [];

    for (const [id, terminal] of this.terminals) {
      if (!terminal.isCLIMode || terminal.follower) continue;
      result.push({
        id,
        cwd: terminal.cwd,
        projectPath: terminal.projectPath,
        claudeProfileId: terminal.claudeProfileId,
        isCLIMode: terminal.isCLIMode,
        dangerouslySkipPermissions: terminal.dangerouslySkipPermissions
      });
    }

    return result;
  }

  /**
   * Update terminal title
   */
  setTitle(id: string, title: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.title = title;
    }
  }

  /**
   * Update terminal worktree config
   */
  setWorktreeConfig(id: string, config: import('../../shared/types').TerminalWorktreeConfig | undefined): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.worktreeConfig = config;
      // Persist immediately when worktree config changes (async to avoid blocking)
      if (terminal.projectPath) {
        SessionHandler.persistSessionAsync(terminal);
      }
    }
  }

  /**
   * Check if a terminal's PTY process is alive
   */
  isTerminalAlive(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Handle terminal data output
   */
  private handleTerminalData(terminal: TerminalProcess, data: string): void {
    TerminalEventHandler.handleTerminalData(terminal, data, this.eventCallbacks);
    this.closeOnCliExit(terminal, data);
  }

  /**
   * A CLI the app launched in this window (Claude Code in an agent window) exited: end the
   * shell so the window closes like after typing `exit`. Skipped when the app restarts the CLI.
   */
  private closeOnCliExit(terminal: TerminalProcess, data: string): void {
    if (!ClaudeIntegration.shouldCloseOnCliExit(terminal, data)) return;
    debugLog('[TerminalManager] CLI exited, closing the window:', terminal.id);
    try {
      terminal.pty.kill();
    } catch (error) {
      debugError('[TerminalManager] Failed to end the shell after the CLI exited:', error);
    }
  }
}
