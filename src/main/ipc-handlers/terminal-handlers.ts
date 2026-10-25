import { ipcMain } from 'electron';
import path from 'path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { ClaudeSessionItem, IPCResult, TerminalCreateOptions, TerminalTaskSessionOptions, ClaudeProfile, ClaudeProfileSettings, ClaudeUsageSnapshot, AllProfilesUsage } from '../../shared/types';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { getUsageMonitor } from '../claude-profile/usage-monitor';
import { TerminalManager } from '../terminal-manager';
import type { AgentManager } from '../agent/agent-manager';
import { projectStore } from '../project-store';
import { terminalNameGenerator } from '../terminal-name-generator';
import { readSettingsFileAsync } from '../settings-utils';
import { appLog } from '../app-logger';
import { createProfileDirectory } from '../claude-profile/profile-utils';
import { isValidConfigDir } from '../utils/config-path-validator';
import { getToolInfoAsync } from '../cli-tool-manager';
import { isDefaultClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { getPathDelimiter, isWindows } from '../platform';
import { isWslRuntime, toRuntimePath } from '../platform/shell-runtime';
import { safeSendToRenderer } from './utils';
import { openTerminalWithCommand } from './claude-code-handlers';


/**
 * Register all terminal-related IPC handlers
 */
export function registerTerminalHandlers(
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null,
  agentManager?: Pick<AgentManager, 'isRunning' | 'getRunSession'>
): void {

  // ============================================
  // Terminal Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (_, options: TerminalCreateOptions): Promise<IPCResult> => {
      try {
        const result = await terminalManager.create(options);
        return result;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create terminal (exception)'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_DESTROY,
    async (_, id: string): Promise<IPCResult> => {
      return terminalManager.destroy(id);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_, id: string, data: string) => {
      terminalManager.write(id, data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (_, id: string, cols: number, rows: number): Promise<IPCResult<{ success: boolean }>> => {
      const success = terminalManager.resize(id, cols, rows);
      return { success, data: { success } };
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INVOKE_CLI,
    (_, id: string, cwd?: string) => {
      // Wrap in async IIFE to allow async settings read without blocking
      (async () => {
        // Read settings asynchronously to check for YOLO mode (dangerously skip permissions)
        const settings = await readSettingsFileAsync();
        const dangerouslySkipPermissions = settings?.dangerouslySkipPermissions === true;

        // Use async version to avoid blocking main process during CLI detection
        await terminalManager.invokeCLIAsync(id, cwd, undefined, dangerouslySkipPermissions);
      })().catch((error) => {
        console.warn('[terminal-handlers] Failed to invoke Claude:', error);
      });
    }
  );

  // Resume a task's Claude Code session in an agent window (`claude --resume <id>` in the task's
  // worktree, on the profile the session ran on). While the task runs, its run is writing to the
  // session, so the window follows it read-only and resumes once the task stops.
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESUME_TASK_SESSION,
    (_, id: string, options: TerminalTaskSessionOptions) => {
      (async () => {
        if (!options?.sessionId || !options.cwd) return;
        const settings = await readSettingsFileAsync();
        const dangerouslySkipPermissions = settings?.dangerouslySkipPermissions === true;
        const taskId = options.taskId;
        // The project comes with the request, because a task id is only unique within one: the
        // renderer builds the request from the task and names its project, so the window follows
        // that project's run and never another project's run of a task of the same id. A request
        // without a project (a window restored from a saved session, or an older renderer) still
        // asks for the run by task id alone, which AgentManager answers only while the id is
        // unambiguous; otherwise the window resumes the session it was handed, which is the
        // session the task's own run wrote and so the right transcript either way.
        const projectId = options.projectId;
        if (taskId && agentManager?.isRunning(taskId, projectId)) {
          terminalManager.followTaskSession(
            id,
            options,
            {
              isRunning: () => agentManager.isRunning(taskId, projectId),
              getSession: () => agentManager.getRunSession(taskId, projectId),
            },
            dangerouslySkipPermissions
          );
          return;
        }
        await terminalManager.resumeTaskSessionAsync(id, options, dangerouslySkipPermissions);
      })().catch((error) => {
        console.warn('[terminal-handlers] Failed to resume the task session:', error);
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GENERATE_NAME,
    async (_, command: string, cwd?: string): Promise<IPCResult<string>> => {
      try {
        const name = await terminalNameGenerator.generateName(command, cwd);
        if (name) {
          return { success: true, data: name };
        } else {
          return { success: false, error: 'Failed to generate terminal name' };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate terminal name'
        };
      }
    }
  );

  // Set terminal title (user renamed terminal in renderer)
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_SET_TITLE,
    (_, id: string, title: string) => {
      terminalManager.setTitle(id, title);
    }
  );

  // Set terminal worktree config (user changed worktree association in renderer)
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG,
    (_, id: string, config: import('../../shared/types').TerminalWorktreeConfig | undefined) => {
      terminalManager.setWorktreeConfig(id, config);
    }
  );

  // Claude profile management (multi-account support)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILES_GET,
    async (): Promise<IPCResult<ClaudeProfileSettings>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const settings = profileManager.getSettings();
        return { success: true, data: settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get Claude profiles'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SAVE,
    async (_, profile: ClaudeProfile): Promise<IPCResult<ClaudeProfile>> => {
      try {
        const profileManager = getClaudeProfileManager();

        // If this is a new profile without an ID, generate one
        if (!profile.id) {
          // Adding an account with the name of an existing one would create `<name>-1`, a
          // second entry that looks the same. Reuse an unfinished sign-in with that name (left
          // behind when the app closed mid sign-in), refuse anything else.
          const abandoned = profileManager.findAbandonedProfileByName(profile.name);
          if (abandoned) {
            return { success: true, data: abandoned };
          }
          const existing = profileManager.findProfileByName(profile.name);
          if (existing) {
            return {
              success: false,
              error: `An account named "${existing.name}" already exists. Choose another name, or use Sign in again on that account.`
            };
          }
          profile.id = profileManager.generateProfileId(profile.name);
        }

        // For non-default profiles, ensure configDir is ALWAYS set
        // This is critical for the CLAUDE_CONFIG_DIR-based auth flow
        // See: docs/LONG_LIVED_AUTH_PLAN.md for context
        if (!profile.isDefault) {
          if (!profile.configDir) {
            // Auto-create a configDir in ~/.claude-profiles/{profile-id}/. The id is unique
            // (generateProfileId adds -N), so two accounts with the same display name don't
            // share a credentials directory.
            console.warn('[CLAUDE_PROFILE_SAVE] Profile missing configDir, creating one:', profile.id);
            profile.configDir = await createProfileDirectory(profile.id);
          }

          // Security: Validate configDir path to prevent path traversal attacks
          if (!isValidConfigDir(profile.configDir)) {
            return {
              success: false,
              error: `Invalid config directory path: ${profile.configDir}. Config directories must be within the user's home directory.`
            };
          }

          // Ensure config directory exists
          const { mkdirSync, existsSync } = await import('fs');
          if (!existsSync(profile.configDir)) {
            mkdirSync(profile.configDir, { recursive: true });
          }
        }

        const savedProfile = profileManager.saveProfile(profile);
        return { success: true, data: savedProfile };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save Claude profile'
        };
      }
    }
  );

  // Claude Code's own sign-in (`claude auth login`) in the user's terminal, like the Claude Code
  // and Graphify installs: on the account's config dir to sign it in again, else on a new one
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_ACCOUNTS_LOGIN,
    async (_, profileId?: string): Promise<IPCResult> => {
      try {
        const claude = await getToolInfoAsync('claude', { refreshIfMissing: true });
        if (!claude.found || !claude.path) return { success: false, error: 'Claude Code CLI not found' };
        const configDir = getClaudeProfileManager().getLoginConfigDir(profileId);
        const isDefault = isDefaultClaudeConfigDir(configDir);
        // In WSL Claude Code runs in a WSL console (Linux paths, Unix syntax)
        if (isWindows() && !isWslRuntime()) {
          // PowerShell: claude from its own folder, the config dir through the environment
          const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
          if (isDefault) delete env.CLAUDE_CONFIG_DIR;
          env.PATH = [path.dirname(claude.path), process.env.PATH].filter(Boolean).join(getPathDelimiter());
          await openTerminalWithCommand('claude auth login', env);
        } else {
          // The terminal starts its own shell, so `env` sets the config dir in the command
          // (Claude Code's default ~/.claude runs without CLAUDE_CONFIG_DIR)
          const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
          const configEnv = isDefault ? '-u CLAUDE_CONFIG_DIR' : `CLAUDE_CONFIG_DIR=${quote(toRuntimePath(configDir))}`;
          await openTerminalWithCommand(`env ${configEnv} ${quote(claude.path)} auth login`);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to open a terminal' };
      }
    }
  );

  // After Claude Code's own sign-in in a terminal: list the account it signed in
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_ACCOUNTS_REDETECT,
    async (): Promise<IPCResult<ClaudeProfileSettings>> => {
      try {
        return { success: true, data: getClaudeProfileManager().redetectAccounts() };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to detect accounts' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_DELETE,
    async (_, profileId: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        if (profileManager.getProfile(profileId)?.detected) {
          return { success: false, error: "This account comes from Claude Code's configuration and can't be removed" };
        }
        const success = profileManager.deleteProfile(profileId);
        if (!success) {
          return { success: false, error: 'Cannot delete default or last profile' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_RENAME,
    async (_, profileId: string, newName: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const success = profileManager.renameProfile(profileId, newName);
        if (!success) {
          return { success: false, error: 'Profile not found or invalid name' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename Claude profile'
        };
      }
    }
  );

  // The Claude Code sessions an agent window can open, as `/resume` lists them there
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_LIST_CLAUDE_SESSIONS,
    async (_, id: string): Promise<IPCResult<ClaudeSessionItem[]>> => {
      try {
        return { success: true, data: await terminalManager.listClaudeSessions(id) };
      } catch (error) {
        appLog.warn('[terminal-handlers] Could not list the window\'s Claude Code sessions:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Could not list the sessions' };
      }
    }
  );

  // End an agent window's session and open another one there (null: a new session)
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_OPEN_CLAUDE_SESSION,
    async (_, id: string, sessionId: string | null): Promise<IPCResult> => {
      try {
        // A new session runs in YOLO mode when the app's setting says so, as "New agent" does
        const settings = await readSettingsFileAsync();
        await terminalManager.openClaudeSession(id, sessionId, settings?.dangerouslySkipPermissions === true);
        return { success: true };
      } catch (error) {
        appLog.warn('[terminal-handlers] Could not open a Claude Code session in the window:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Could not open the session' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE,
    async (_, profileId: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const previousProfile = profileManager.getActiveProfile();
        const previousProfileId = previousProfile.id;

        const success = profileManager.setActiveProfile(profileId);

        if (!success) {
          return { success: false, error: 'Profile not found' };
        }

        const newProfile = profileManager.getProfile(profileId);

        // Agent windows running Claude Code continue their own session on the new account, in
        // place: same shell, id and place in the grid. Plain terminals are left as they are. Each
        // window ends Claude Code first (up to a few seconds), so this runs after the reply
        if (previousProfileId !== profileId) {
          for (const terminal of terminalManager.getTerminalsForProfileChange()) {
            terminalManager.moveAgentWindowToAccount(terminal.id, profileId, newProfile?.configDir).catch((error) => {
              appLog.warn('[terminal-handlers] Could not move an agent window to the new account:', error);
            });
          }
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set active Claude profile'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SWITCH,
    async (_, terminalId: string, profileId: string): Promise<IPCResult> => {
      try {
        const result = await terminalManager.switchClaudeProfile(terminalId, profileId);
        return result;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to switch Claude profile'
        };
      }
    }
  );

  // CLAUDE_PROFILE_INITIALIZE handler has been removed.
  // Use CLAUDE_PROFILE_AUTHENTICATE (in claude-code-handlers.ts) instead,
  // which opens a visible terminal for the user to run /login manually.
  // Authentication status is checked via CLAUDE_PROFILE_VERIFY_AUTH with polling.

  // Set OAuth token for a profile (used when capturing from terminal or manual input)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN,
    async (_, profileId: string, token: string, email?: string): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        const success = profileManager.setProfileToken(profileId, token, email);
        if (!success) {
          return { success: false, error: 'Profile not found' };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set OAuth token'
        };
      }
    }
  );

  // TERMINAL_OAUTH_CODE_SUBMIT handler has been removed.
  // The new authentication flow (CLAUDE_PROFILE_AUTHENTICATE) doesn't require
  // manual code submission - the user completes OAuth directly in the browser.

  // Get auto-switch settings
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS,
    async (): Promise<IPCResult<import('../../shared/types').ClaudeAutoSwitchSettings>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const settings = profileManager.getAutoSwitchSettings();
        return { success: true, data: settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get auto-switch settings'
        };
      }
    }
  );

  // Update auto-switch settings
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH,
    async (_, settings: Partial<import('../../shared/types').ClaudeAutoSwitchSettings>): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();
        profileManager.updateAutoSwitchSettings(settings);

        // Restart usage monitor with new settings
        const monitor = getUsageMonitor();
        monitor.stop();
        monitor.start();

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update auto-switch settings'
        };
      }
    }
  );

  // Fetch usage by sending /usage command to terminal
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_FETCH_USAGE,
    async (_, terminalId: string): Promise<IPCResult> => {
      try {
        // Send /usage command to the terminal
        terminalManager.write(terminalId, '/usage\r');
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch usage'
        };
      }
    }
  );

  // Get best available profile
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_GET_BEST_PROFILE,
    async (_, excludeProfileId?: string): Promise<IPCResult<ClaudeProfile | null>> => {
      try {
        const profileManager = getClaudeProfileManager();
        const bestProfile = profileManager.getBestAvailableProfile(excludeProfileId);
        return { success: true, data: bestProfile };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get best profile'
        };
      }
    }
  );

  // Retry rate-limited operation with a different profile
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE,
    async (_, request: import('../../shared/types').RetryWithProfileRequest): Promise<IPCResult> => {
      try {
        const profileManager = getClaudeProfileManager();

        // Set the new active profile
        profileManager.setActiveProfile(request.profileId);

        // Get the project
        const project = projectStore.getProject(request.projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Retry based on the source
        switch (request.source) {
          case 'task':
            // For tasks, we would need to restart the task
            // This is complex and would need task state restoration
            return { success: true, data: { message: 'Please restart the task manually' } };

          default:
            return { success: true };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to retry with profile'
        };
      }
    }
  );

  // ============================================
  // Usage Monitoring (Proactive Account Switching)
  // ============================================

  // Request current usage snapshot
  ipcMain.handle(
    IPC_CHANNELS.USAGE_REQUEST,
    async (): Promise<IPCResult<import('../../shared/types').ClaudeUsageSnapshot | null>> => {
      try {
        const monitor = getUsageMonitor();
        const usage = monitor.getCurrentUsage();
        return { success: true, data: usage };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get current usage'
        };
      }
    }
  );

  // Request all profiles usage immediately (for startup/refresh)
  // Optional forceRefresh parameter bypasses cache to get fresh data
  ipcMain.handle(
    IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST,
    async (_event: IpcMainInvokeEvent, forceRefresh: boolean = false): Promise<IPCResult<AllProfilesUsage | null>> => {
      try {
        const monitor = getUsageMonitor();
        const allProfilesUsage = await monitor.getAllProfilesUsage(forceRefresh);
        return { success: true, data: allProfilesUsage };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get all profiles usage'
        };
      }
    }
  );


  // Terminal session management (persistence/restore)
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_GET_SESSIONS,
    async (_, projectPath: string): Promise<IPCResult<import('../../shared/types').TerminalSession[]>> => {
      try {
        const sessions = terminalManager.getSavedSessions(projectPath);
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get terminal sessions'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESTORE_SESSION,
    async (_, session: import('../../shared/types').TerminalSession, cols?: number, rows?: number): Promise<IPCResult<import('../../shared/types').TerminalRestoreResult>> => {
      try {
        const result = await terminalManager.restore(session, cols, rows);
        return {
          success: result.success,
          data: {
            success: result.success,
            terminalId: session.id,
            outputBuffer: result.outputBuffer,
            error: result.error
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to restore terminal session'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CLEAR_SESSIONS,
    async (_, projectPath: string): Promise<IPCResult> => {
      try {
        terminalManager.clearSavedSessions(projectPath);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear terminal sessions'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESUME_CLAUDE,
    (_, id: string, options?: { dangerouslySkipPermissions?: boolean }) => {
      // Use async version to avoid blocking main process during CLI detection
      terminalManager.resumeClaudeAsync(id, options).catch((error) => {
        console.warn('[terminal-handlers] Failed to resume Claude:', error);
      });
    }
  );

  // Resume a restored terminal's Claude Code session
  // The renderer sends this once the terminal's window is shown (queued, one window at a time)
  ipcMain.on(
    IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME,
    (_, id: string) => {
      terminalManager.activateDeferredResume(id).catch((error) => {
        console.warn('[terminal-handlers] Failed to activate deferred resume:', error);
      });
    }
  );


  // Check if a terminal's PTY process is alive
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE,
    async (_, terminalId: string): Promise<IPCResult<{ alive: boolean }>> => {
      try {
        const alive = terminalManager.isTerminalAlive(terminalId);
        return { success: true, data: { alive } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check terminal status'
        };
      }
    }
  );

  // Update terminal display orders after drag-drop reorder
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS,
    async (
      _,
      projectPath: string,
      orders: Array<{ terminalId: string; displayOrder: number }>
    ): Promise<IPCResult> => {
      try {
        terminalManager.updateDisplayOrders(projectPath, orders);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update display orders'
        };
      }
    }
  );
}

/**
 * Initialize usage monitor event forwarding to renderer process
 * Call this after mainWindow is created
 */
export function initializeUsageMonitorForwarding(getWindow: () => BrowserWindow | null): void {
  const monitor = getUsageMonitor();

  // Forward usage updates to every project window
  monitor.on('usage-updated', (usage: ClaudeUsageSnapshot | null) => {
    safeSendToRenderer(getWindow, IPC_CHANNELS.USAGE_UPDATED, usage);
  });

  // Forward all profiles usage updates to renderer (for multi-profile display)
  monitor.on('all-profiles-usage-updated', (allProfilesUsage: AllProfilesUsage) => {
    safeSendToRenderer(getWindow, IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, allProfilesUsage);
  });

  // Forward proactive swap notifications to renderer
  monitor.on('show-swap-notification', (notification: unknown) => {
    safeSendToRenderer(getWindow, IPC_CHANNELS.PROACTIVE_SWAP_NOTIFICATION, notification);
  });
}
