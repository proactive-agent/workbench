import { ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

// Increase max listeners to accommodate up to 24 terminals (MAX_TERMINALS_LIMIT) with multiple event types
// Each terminal can have listeners for: output, exit, titleChange, claudeSession, etc.
// Default is 10, so we need more headroom
ipcRenderer.setMaxListeners(100);

import type {
  IPCResult,
  TerminalCreateOptions,
  ClaudeProfile,
  ClaudeProfileSettings,
  CreateTerminalWorktreeRequest,
  TerminalWorktreeConfig,
  TerminalWorktreeResult,
  OtherWorktreeInfo,
  AgentWindowMatch,
  AgentWindowOpenRequest,
  SessionMessageOrigin,
} from '../../shared/types';

export interface TerminalAPI {
  // Terminal Operations
  createTerminal: (options: TerminalCreateOptions) => Promise<IPCResult>;
  destroyTerminal: (id: string) => Promise<IPCResult>;
  sendTerminalInput: (id: string, data: string) => void;
  /** The file's path on disk, or '' for a file that has none (an image pasted from the clipboard) */
  getPathForFile: (file: File) => string;
  /** Host paths as the agent windows' shell sees them (in WSL `C:\x` becomes `/mnt/c/x`) */
  toTerminalRuntimePaths: (paths: string[]) => Promise<string[]>;
  /** Files copied in a file manager that a paste event didn't carry (Linux, WSLg), as the runtime's paths */
  readClipboardFilePaths: () => Promise<string[]>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<IPCResult<{ success: boolean }>>;
  invokeCLIInTerminal: (id: string, cwd?: string) => void;
  resumeTaskSessionInTerminal: (id: string, options: import('../../shared/types').TerminalTaskSessionOptions) => void;
  setTerminalTitle: (id: string, title: string) => void;
  setTerminalWorktreeConfig: (id: string, config: TerminalWorktreeConfig | undefined) => void;

  // Terminal Session Management
  getTerminalSessions: (projectPath: string) => Promise<IPCResult<import('../../shared/types').TerminalSession[]>>;
  restoreTerminalSession: (
    session: import('../../shared/types').TerminalSession,
    cols?: number,
    rows?: number
  ) => Promise<IPCResult<import('../../shared/types').TerminalRestoreResult>>;
  clearTerminalSessions: (projectPath: string) => Promise<IPCResult>;
  resumeClaudeInTerminal: (id: string, options?: { dangerouslySkipPermissions?: boolean }) => void;
  listClaudeSessions: (id: string) => Promise<IPCResult<import('../../shared/types').ClaudeSessionItem[]>>;
  openClaudeSession: (id: string, sessionId: string | null) => Promise<IPCResult>;
  activateDeferredClaudeResume: (id: string) => void;
  checkTerminalPtyAlive: (terminalId: string) => Promise<IPCResult<{ alive: boolean }>>;
  updateTerminalDisplayOrders: (
    projectPath: string,
    orders: Array<{ terminalId: string; displayOrder: number }>
  ) => Promise<IPCResult>;

  // Terminal Worktree Operations (isolated development)
  createTerminalWorktree: (request: CreateTerminalWorktreeRequest) => Promise<TerminalWorktreeResult>;
  listTerminalWorktrees: (projectPath: string) => Promise<IPCResult<TerminalWorktreeConfig[]>>;
  removeTerminalWorktree: (projectPath: string, name: string, deleteBranch?: boolean) => Promise<IPCResult>;
  listOtherWorktrees: (projectPath: string) => Promise<IPCResult<OtherWorktreeInfo[]>>;

  // Terminal Event Listeners
  onTerminalOutput: (callback: (id: string, data: string) => void) => () => void;
  onTerminalExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onTerminalTitleChange: (callback: (id: string, title: string) => void) => () => void;
  onTerminalWorktreeConfigChange: (callback: (id: string, config: TerminalWorktreeConfig | undefined) => void) => () => void;
  onTerminalOAuthToken: (
    callback: (info: { terminalId: string; profileId?: string; email?: string; success: boolean; message?: string; detectedAt: string }) => void
  ) => () => void;
  onTerminalAuthCreated: (
    callback: (info: { terminalId: string; profileId: string; profileName: string }) => void
  ) => () => void;
  onTerminalOAuthCodeNeeded: (
    callback: (info: { terminalId: string; profileId: string; profileName: string }) => void
  ) => () => void;
  submitOAuthCode: (terminalId: string, code: string) => Promise<IPCResult>;
  onTerminalClaudeBusy: (callback: (id: string, isBusy: boolean) => void) => () => void;
  /** An agent window answers a chat's message (read-only), or no longer does (null) */
  onTerminalReceivingMessage: (callback: (id: string, from: SessionMessageOrigin | null) => void) => () => void;
  /** Give a window answering a message back to the user */
  takeOverTerminal: (id: string) => void;
  /** An agent window of the project by its name (agent-…), open or closed */
  findAgentWindow: (projectPath: string, name: string) => Promise<AgentWindowMatch | null>;
  /** A chat messages a closed agent window: open it again */
  onAgentWindowOpenRequest: (callback: (request: AgentWindowOpenRequest) => void) => () => void;
  onTerminalClaudeExit: (callback: (id: string) => void) => () => void;
  onTerminalPendingResume: (callback: (id: string) => void) => () => void;

  // Claude Profile Management
  getClaudeProfiles: () => Promise<IPCResult<ClaudeProfileSettings>>;
  saveClaudeProfile: (profile: ClaudeProfile) => Promise<IPCResult<ClaudeProfile>>;
  /** `replacementId`: the account that takes the deleted one's place when it is the account in use */
  deleteClaudeProfile: (profileId: string, replacementId?: string) => Promise<IPCResult>;
  loginClaudeAccount: (profileId?: string) => Promise<IPCResult>;
  redetectClaudeAccounts: () => Promise<IPCResult<ClaudeProfileSettings>>;
  renameClaudeProfile: (profileId: string, newName: string) => Promise<IPCResult>;
  /** Switch the Claude account; with `projectId`, saved as that project's account (the window's) */
  setActiveClaudeProfile: (profileId: string, projectId?: string) => Promise<IPCResult>;
  switchClaudeProfile: (terminalId: string, profileId: string) => Promise<IPCResult>;
  initializeClaudeProfile: (profileId: string) => Promise<IPCResult>;
  setClaudeProfileToken: (profileId: string, token: string, email?: string) => Promise<IPCResult>;
  authenticateClaudeProfile: (profileId: string) => Promise<IPCResult<{ terminalId: string; configDir: string }>>;
  verifyClaudeProfileAuth: (profileId: string) => Promise<IPCResult<{ authenticated: boolean; email?: string }>>;
  claudeAuthLoginSubprocess: (profileId: string) => Promise<IPCResult<{ authenticated: boolean; email?: string }>>;
  cancelClaudeAuthLogin: (profileId: string) => Promise<IPCResult>;
  onClaudeAuthLoginProgress: (callback: (data: { status: string; message?: string }) => void) => () => void;
  fetchClaudeUsage: (terminalId: string) => Promise<IPCResult>;
  onAuthFailure: (callback: (info: import('../../shared/types').AuthFailureInfo) => void) => () => void;
  retryWithProfile: (request: import('../../shared/types').RetryWithProfileRequest) => Promise<IPCResult>;

  // Usage Monitoring
  requestUsageUpdate: () => Promise<IPCResult<import('../../shared/types').ClaudeUsageSnapshot | null>>;
  requestAllProfilesUsage: (forceRefresh?: boolean) => Promise<IPCResult<import('../../shared/types').AllProfilesUsage | null>>;
  onUsageUpdated: (callback: (usage: import('../../shared/types').ClaudeUsageSnapshot | null) => void) => () => void;
  onAllProfilesUsageUpdated: (callback: (allProfilesUsage: import('../../shared/types').AllProfilesUsage) => void) => () => void;
}

export const createTerminalAPI = (): TerminalAPI => ({
  // Terminal Operations
  createTerminal: (options: TerminalCreateOptions): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options),

  destroyTerminal: (id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DESTROY, id),

  sendTerminalInput: (id: string, data: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, id, data),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  toTerminalRuntimePaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RUNTIME_PATHS, paths),

  readClipboardFilePaths: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CLIPBOARD_FILES),

  resizeTerminal: (id: string, cols: number, rows: number): Promise<IPCResult<{ success: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, id, cols, rows),

  invokeCLIInTerminal: (id: string, cwd?: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_INVOKE_CLI, id, cwd),

  resumeTaskSessionInTerminal: (id: string, options: import('../../shared/types').TerminalTaskSessionOptions): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESUME_TASK_SESSION, id, options),

  setTerminalTitle: (id: string, title: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_SET_TITLE, id, title),

  setTerminalWorktreeConfig: (id: string, config: TerminalWorktreeConfig | undefined): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG, id, config),

  // Terminal Session Management
  getTerminalSessions: (projectPath: string): Promise<IPCResult<import('../../shared/types').TerminalSession[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_GET_SESSIONS, projectPath),

  restoreTerminalSession: (
    session: import('../../shared/types').TerminalSession,
    cols?: number,
    rows?: number
  ): Promise<IPCResult<import('../../shared/types').TerminalRestoreResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESTORE_SESSION, session, cols, rows),

  clearTerminalSessions: (projectPath: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CLEAR_SESSIONS, projectPath),

  resumeClaudeInTerminal: (id: string, options?: { dangerouslySkipPermissions?: boolean }): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESUME_CLAUDE, id, options),

  listClaudeSessions: (id: string): Promise<IPCResult<import('../../shared/types').ClaudeSessionItem[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST_CLAUDE_SESSIONS, id),

  openClaudeSession: (id: string, sessionId: string | null): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_OPEN_CLAUDE_SESSION, id, sessionId),

  activateDeferredClaudeResume: (id: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME, id),

  checkTerminalPtyAlive: (terminalId: string): Promise<IPCResult<{ alive: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE, terminalId),

  updateTerminalDisplayOrders: (
    projectPath: string,
    orders: Array<{ terminalId: string; displayOrder: number }>
  ): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS, projectPath, orders),

  // Terminal Worktree Operations (isolated development)
  createTerminalWorktree: (request: CreateTerminalWorktreeRequest): Promise<TerminalWorktreeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WORKTREE_CREATE, request),

  listTerminalWorktrees: (projectPath: string): Promise<IPCResult<TerminalWorktreeConfig[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WORKTREE_LIST, projectPath),

  removeTerminalWorktree: (projectPath: string, name: string, deleteBranch: boolean = false): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE, projectPath, name, deleteBranch),

  listOtherWorktrees: (projectPath: string): Promise<IPCResult<OtherWorktreeInfo[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER, projectPath),

  // Terminal Event Listeners
  onTerminalOutput: (
    callback: (id: string, data: string) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      data: string
    ): void => {
      callback(id, data);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
    };
  },

  onTerminalExit: (
    callback: (id: string, exitCode: number) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      exitCode: number
    ): void => {
      callback(id, exitCode);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, handler);
    };
  },

  onTerminalTitleChange: (
    callback: (id: string, title: string) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      title: string
    ): void => {
      callback(id, title);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, handler);
    };
  },

  onTerminalWorktreeConfigChange: (
    callback: (id: string, config: TerminalWorktreeConfig | undefined) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      config: TerminalWorktreeConfig | undefined
    ): void => {
      callback(id, config);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_WORKTREE_CONFIG_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_WORKTREE_CONFIG_CHANGE, handler);
    };
  },

  onTerminalOAuthToken: (
    callback: (info: { terminalId: string; profileId?: string; email?: string; success: boolean; message?: string; detectedAt: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: { terminalId: string; profileId?: string; email?: string; success: boolean; message?: string; detectedAt: string }
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, handler);
    };
  },

  onTerminalAuthCreated: (
    callback: (info: { terminalId: string; profileId: string; profileName: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: { terminalId: string; profileId: string; profileName: string }
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_AUTH_CREATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_AUTH_CREATED, handler);
    };
  },

  onTerminalOAuthCodeNeeded: (
    callback: (info: { terminalId: string; profileId: string; profileName: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: { terminalId: string; profileId: string; profileName: string }
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OAUTH_CODE_NEEDED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OAUTH_CODE_NEEDED, handler);
    };
  },

  submitOAuthCode: (terminalId: string, code: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_OAUTH_CODE_SUBMIT, terminalId, code),

  onTerminalClaudeBusy: (
    callback: (id: string, isBusy: boolean) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      isBusy: boolean
    ): void => {
      callback(id, isBusy);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, handler);
    };
  },

  onTerminalReceivingMessage: (
    callback: (id: string, from: SessionMessageOrigin | null) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, from: SessionMessageOrigin | null): void => callback(id, from);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_RECEIVING_MESSAGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_RECEIVING_MESSAGE, handler);
    };
  },

  takeOverTerminal: (id: string): void => ipcRenderer.send(IPC_CHANNELS.TERMINAL_TAKE_OVER, id),

  findAgentWindow: (projectPath: string, name: string): Promise<AgentWindowMatch | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_FIND_AGENT_WINDOW, projectPath, name),

  onAgentWindowOpenRequest: (callback: (request: AgentWindowOpenRequest) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentWindowOpenRequest): void => callback(request);
    ipcRenderer.on(IPC_CHANNELS.AGENT_WINDOW_OPEN_REQUEST, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_WINDOW_OPEN_REQUEST, handler);
    };
  },

  onTerminalClaudeExit: (
    callback: (id: string) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string
    ): void => {
      callback(id);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_CLAUDE_EXIT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_CLAUDE_EXIT, handler);
    };
  },

  onTerminalPendingResume: (
    callback: (id: string) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string
    ): void => {
      callback(id);
    };
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_PENDING_RESUME, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_PENDING_RESUME, handler);
    };
  },

  // Claude Profile Management
  getClaudeProfiles: (): Promise<IPCResult<ClaudeProfileSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILES_GET),

  saveClaudeProfile: (profile: ClaudeProfile): Promise<IPCResult<ClaudeProfile>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_SAVE, profile),

  deleteClaudeProfile: (profileId: string, replacementId?: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_DELETE, profileId, replacementId),

  loginClaudeAccount: (profileId?: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_LOGIN, profileId),

  redetectClaudeAccounts: (): Promise<IPCResult<ClaudeProfileSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACCOUNTS_REDETECT),

  renameClaudeProfile: (profileId: string, newName: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_RENAME, profileId, newName),

  setActiveClaudeProfile: (profileId: string, projectId?: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE, profileId, projectId),

  switchClaudeProfile: (terminalId: string, profileId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_SWITCH, terminalId, profileId),

  initializeClaudeProfile: (profileId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_INITIALIZE, profileId),

  setClaudeProfileToken: (profileId: string, token: string, email?: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN, profileId, token, email),

  authenticateClaudeProfile: (profileId: string): Promise<IPCResult<{ terminalId: string; configDir: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_AUTHENTICATE, profileId),

  verifyClaudeProfileAuth: (profileId: string): Promise<IPCResult<{ authenticated: boolean; email?: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_VERIFY_AUTH, profileId),

  claudeAuthLoginSubprocess: (profileId: string): Promise<IPCResult<{ authenticated: boolean; email?: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_SUBPROCESS, profileId),

  cancelClaudeAuthLogin: (profileId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_CANCEL, profileId),

  onClaudeAuthLoginProgress: (
    callback: (data: { status: string; message?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { status: string; message?: string }
    ): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, handler);
    };
  },

  fetchClaudeUsage: (terminalId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROFILE_FETCH_USAGE, terminalId),

  onAuthFailure: (
    callback: (info: import('../../shared/types').AuthFailureInfo) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: import('../../shared/types').AuthFailureInfo
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC_CHANNELS.CLAUDE_AUTH_FAILURE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_AUTH_FAILURE, handler);
    };
  },

  retryWithProfile: (request: import('../../shared/types').RetryWithProfileRequest): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE, request),

  // Usage Monitoring
  requestUsageUpdate: (): Promise<IPCResult<import('../../shared/types').ClaudeUsageSnapshot | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.USAGE_REQUEST),

  requestAllProfilesUsage: (forceRefresh?: boolean): Promise<IPCResult<import('../../shared/types').AllProfilesUsage | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST, forceRefresh ?? false),

  onUsageUpdated: (
    callback: (usage: import('../../shared/types').ClaudeUsageSnapshot | null) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      usage: import('../../shared/types').ClaudeUsageSnapshot | null
    ): void => {
      callback(usage);
    };
    ipcRenderer.on(IPC_CHANNELS.USAGE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.USAGE_UPDATED, handler);
    };
  },

  onAllProfilesUsageUpdated: (
    callback: (allProfilesUsage: import('../../shared/types').AllProfilesUsage) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      allProfilesUsage: import('../../shared/types').AllProfilesUsage
    ): void => {
      callback(allProfilesUsage);
    };
    ipcRenderer.on(IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ALL_PROFILES_USAGE_UPDATED, handler);
    };
  }
});
