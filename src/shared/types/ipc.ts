/**
 * IPC (Inter-Process Communication) types for Electron API
 */

/** A task's Claude Code session to resume in an agent window (`claude --resume <sessionId>`) */
export interface TerminalTaskSessionOptions {
  /** Claude Code session id of the task run */
  sessionId: string;
  /** Directory to resume in (the task's worktree, where the session ran) */
  cwd: string;
  /** Claude profile the session ran on */
  profileId?: string;
  /** Claude config dir that holds the session transcript */
  configDir?: string;
  /** Task the session belongs to: while it runs, the window follows the session read-only */
  taskId?: string;
  /**
   * Project the task belongs to. A task id is only unique within a project, so the main process
   * needs it to find the right run among the projects that may be running a task of this id.
   * Optional because a window restored from a saved session, or an older renderer, sends the
   * request without one; the session is then resumed instead of followed.
   */
  projectId?: string;
}

import type { IPCResult } from './common';
import type { KanbanPreferences } from './kanban';
import type {
  Project,
  ProjectSettings,
  AutoBuildVersionInfo,
  InitializationResult,
  CreateProjectFolderResult,
  GitStatus,
  CustomMcpServer,
  McpHealthCheckResult,
  McpTestConnectionResult
} from './project';
import type {
  Task,
  TaskStatus,
  RateLimitHold,
  TaskStartOptions,
  TaskReviewOptions,
  ArchivedTaskRun,
  ImplementationPlan,
  ExecutionProgress,
  WorktreeStatus,
  WorktreeMergeResult,
  WorktreeDiscardResult,
  WorktreeListResult,
  WorktreeCreatePROptions,
  WorktreeCreatePRResult,
  WorktreeMergePROptions,
  WorktreeMergePRResult,
  WorktreeLocalMergeResult,
  MergePRProgress,
  LocalMergeProgress,
  PullRequestState,
  TaskRecoveryResult,
  TaskRecoveryOptions,
  TaskMetadata,
  TaskLogs,
  TaskLogStreamChunk,
  ImageAttachment,
  ReviewReason,
  MergeProgress
} from './task';
import type {
  TerminalCreateOptions,
  TerminalSession,
  TerminalRestoreResult,
  AuthFailureInfo,
  RetryWithProfileRequest,
  CreateTerminalWorktreeRequest,
  TerminalWorktreeConfig,
  TerminalWorktreeResult,
  OtherWorktreeInfo,
  ClaudeSessionItem,
} from './terminal';
import type {
  ClaudeProfileSettings,
  ClaudeProfile,
  ClaudeAutoSwitchSettings,
  ClaudeUsageSnapshot,
  AllProfilesUsage
} from './agent';
import type { AppSettings } from './settings';
import type { AppUpdateCheckResult, AppUpdateInfo, AppUpdateProgress, AppUpdateAvailableEvent, AppUpdateDownloadedEvent, AppUpdateErrorEvent } from './app-update';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsModelConfig
} from './insights';
import type { APIProfile, ProfilesFile, TestConnectionResult, DiscoverModelsResult } from './profile';

// ============================================
// Branch Types
// ============================================

/**
 * Branch type indicator for distinguishing local from remote branches
 */
type GitBranchType = 'local' | 'remote';

/**
 * Structured branch information for UI display with type indicators
 * Used in branch selection dropdowns to distinguish local vs remote branches
 */
export interface GitBranchDetail {
  /** The branch name (e.g., 'main', 'origin/main') */
  name: string;
  /** Whether this is a local or remote branch */
  type: GitBranchType;
  /** Display name for UI (e.g., 'main' for local, 'origin/main' for remote) */
  displayName: string;
  /** Whether this is the currently checked out branch */
  isCurrent?: boolean;
}

// ============================================
// Electron API
// ============================================

// Electron API exposed via contextBridge
// Tab state interface (persisted in main process)
interface TabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

export interface ElectronAPI {
  // Project operations
  addProject: (projectPath: string) => Promise<IPCResult<Project>>;
  removeProject: (projectId: string) => Promise<IPCResult>;
  getProjects: () => Promise<IPCResult<Project[]>>;
  getProjectCostMetrics: () => Promise<IPCResult<import('./project').ProjectCostMetrics[]>>;
  watchProjectCostMetrics: () => Promise<IPCResult>;
  unwatchProjectCostMetrics: () => Promise<IPCResult>;
  onProjectCostMetricsChanged: (callback: () => void) => () => void;
  updateProjectSettings: (projectId: string, settings: Partial<ProjectSettings>) => Promise<IPCResult>;
  initializeProject: (projectId: string) => Promise<IPCResult<InitializationResult>>;
  checkProjectVersion: (projectId: string) => Promise<IPCResult<AutoBuildVersionInfo>>;

  // Tab State (persisted in main process for reliability)
  getTabState: () => Promise<IPCResult<TabState>>;
  saveTabState: (tabState: TabState) => Promise<IPCResult>;

  /** A project was added or removed (in this window or another one) */
  onProjectListChanged: (callback: () => void) => () => void;

  // Kanban preferences (per-project column collapse state)
  getKanbanPreferences: (projectId: string) => Promise<IPCResult<KanbanPreferences | null>>;
  saveKanbanPreferences: (projectId: string, preferences: KanbanPreferences) => Promise<IPCResult>;

  // Task operations
  //
  // The calls that reach a task's Claude Code run - start, stop, retry, review, status change,
  // running check, recovery and delete - take the id of the project whose board the user acted on
  // as their last argument. A task id is only unique inside its project, and runs are held per
  // project and task, so the main process cannot work the project out from the task id alone:
  // searching for the id finds a project that holds such a task, not the one running it. The
  // worktree calls below carry it for the same reason: without it a merge, a pull request or a
  // discard can land on another project's worktree.
  getTasks: (projectId: string, options?: { forceRefresh?: boolean }) => Promise<IPCResult<Task[]>>;
  createTask: (projectId: string, title: string, description: string, metadata?: TaskMetadata) => Promise<IPCResult<Task>>;
  deleteTask: (taskId: string, projectId?: string) => Promise<IPCResult>;
  updateTask: (taskId: string, updates: { title?: string; description?: string }, projectId?: string) => Promise<IPCResult<Task>>;
  startTask: (taskId: string, options?: TaskStartOptions, projectId?: string) => void;
  stopTask: (taskId: string, projectId?: string) => void;
  retryTask: (taskId: string, projectId?: string) => Promise<IPCResult<{ action: 'started' | 'queued' }>>;
  submitReview: (taskId: string, approved: boolean, feedback?: string, images?: ImageAttachment[], options?: TaskReviewOptions, projectId?: string) => Promise<IPCResult>;
  updateTaskStatus: (taskId: string, status: TaskStatus, options?: { forceCleanup?: boolean; keepWorktree?: boolean }, projectId?: string) => Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }>;
  recoverStuckTask: (taskId: string, options?: TaskRecoveryOptions, projectId?: string) => Promise<IPCResult<TaskRecoveryResult>>;
  checkTaskRunning: (taskId: string, projectId?: string) => Promise<IPCResult<boolean>>;

  // Image operations
  loadImageThumbnail: (projectPath: string, specId: string, imagePath: string) => Promise<IPCResult<string>>;

  // Worktree change detection
  checkWorktreeChanges: (taskId: string, projectId?: string) => Promise<IPCResult<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number }>>;

  // Workspace management (for human review)
  // Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
  getWorktreeStatus: (taskId: string, projectId?: string) => Promise<IPCResult<WorktreeStatus>>;
  mergeWorktree: (taskId: string, options?: { noCommit?: boolean }, projectId?: string) => Promise<IPCResult<WorktreeMergeResult>>;
  mergeWorktreePreview: (taskId: string, projectId?: string) => Promise<IPCResult<WorktreeMergeResult>>;
  createWorktreePR: (taskId: string, options?: WorktreeCreatePROptions, projectId?: string) => Promise<IPCResult<WorktreeCreatePRResult>>;
  mergeWorktreePR: (taskId: string, options?: WorktreeMergePROptions, projectId?: string) => Promise<IPCResult<WorktreeMergePRResult>>;
  mergeWorktreeLocal: (taskId: string, projectId?: string) => Promise<IPCResult<WorktreeLocalMergeResult>>;
  getWorktreePRState: (taskId: string, projectId?: string) => Promise<IPCResult<PullRequestState>>;
  discardWorktree: (taskId: string, skipStatusChange?: boolean, projectId?: string) => Promise<IPCResult<WorktreeDiscardResult>>;
  clearStagedState: (taskId: string, projectId?: string) => Promise<IPCResult<{ cleared: boolean }>>;
  listWorktrees: (projectId: string, options?: { includeStats?: boolean }) => Promise<IPCResult<WorktreeListResult>>;

  // Task archive operations
  archiveTasks: (projectId: string, taskIds: string[], version?: string) => Promise<IPCResult<boolean>>;
  unarchiveTasks: (projectId: string, taskIds: string[]) => Promise<IPCResult<boolean>>;

  // Event listeners
  onTaskProgress: (callback: (taskId: string, plan: ImplementationPlan, projectId?: string) => void) => () => void;
  onTaskError: (callback: (taskId: string, error: string, projectId?: string) => void) => () => void;
  onTaskLog: (callback: (taskId: string, log: string, projectId?: string) => void) => () => void;
  onTaskStatusChange: (callback: (taskId: string, status: TaskStatus, projectId?: string, reviewReason?: ReviewReason) => void) => () => void;
  onTaskRateLimitHoldChange: (callback: (taskId: string, hold: RateLimitHold | null, projectId?: string) => void) => () => void;
  setQueueOrder: (projectId: string, order: string[]) => void;
  onTaskClaudeRunUpdate: (callback: (taskId: string, run: import('./claude-code').ClaudeRunInfo, projectId?: string) => void) => () => void;
  onTaskExecutionProgress: (callback: (taskId: string, progress: ExecutionProgress, projectId?: string) => void) => () => void;

  // Terminal operations
  createTerminal: (options: TerminalCreateOptions) => Promise<IPCResult>;
  destroyTerminal: (id: string) => Promise<IPCResult>;
  sendTerminalInput: (id: string, data: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<IPCResult<{ success: boolean }>>;
  invokeCLIInTerminal: (id: string, cwd?: string) => void;
  resumeTaskSessionInTerminal: (id: string, options: TerminalTaskSessionOptions) => void;
  generateTerminalName: (command: string, cwd?: string) => Promise<IPCResult<string>>;
  setTerminalTitle: (id: string, title: string) => void;
  setTerminalWorktreeConfig: (id: string, config: TerminalWorktreeConfig | undefined) => void;

  // Terminal session management (persistence/restore)
  getTerminalSessions: (projectPath: string) => Promise<IPCResult<TerminalSession[]>>;
  restoreTerminalSession: (session: TerminalSession, cols?: number, rows?: number) => Promise<IPCResult<TerminalRestoreResult>>;
  clearTerminalSessions: (projectPath: string) => Promise<IPCResult>;
  resumeClaudeInTerminal: (id: string, options?: { dangerouslySkipPermissions?: boolean }) => void;
  /** The Claude Code sessions an agent window can open: what `/resume` lists in its directory */
  listClaudeSessions: (id: string) => Promise<IPCResult<ClaudeSessionItem[]>>;
  /** End the window's Claude Code session and open the given one, or a new one (null) */
  openClaudeSession: (id: string, sessionId: string | null) => Promise<IPCResult>;
  activateDeferredClaudeResume: (id: string) => void;
  saveTerminalBuffer: (terminalId: string, serialized: string) => Promise<void>;
  checkTerminalPtyAlive: (terminalId: string) => Promise<IPCResult<{ alive: boolean }>>;
  updateTerminalDisplayOrders: (
    projectPath: string,
    orders: Array<{ terminalId: string; displayOrder: number }>
  ) => Promise<IPCResult>;

  // Terminal worktree operations (isolated development)
  createTerminalWorktree: (request: CreateTerminalWorktreeRequest) => Promise<TerminalWorktreeResult>;
  listTerminalWorktrees: (projectPath: string) => Promise<IPCResult<TerminalWorktreeConfig[]>>;
  removeTerminalWorktree: (projectPath: string, name: string, deleteBranch?: boolean) => Promise<IPCResult>;
  listOtherWorktrees: (projectPath: string) => Promise<IPCResult<OtherWorktreeInfo[]>>;

  // Terminal event listeners
  onTerminalOutput: (callback: (id: string, data: string) => void) => () => void;
  onTerminalExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onTerminalTitleChange: (callback: (id: string, title: string) => void) => () => void;
  /** Listen for worktree config changes (synced from main process during restoration) */
  onTerminalWorktreeConfigChange: (callback: (id: string, config: TerminalWorktreeConfig | undefined) => void) => () => void;
  /** Listen for OAuth authentication completion (token is auto-saved to profile, never exposed to frontend) */
  onTerminalOAuthToken: (callback: (info: {
    terminalId: string;
    profileId?: string;
    email?: string;
    success: boolean;
    message?: string;
    detectedAt: string;
  }) => void) => () => void;
  /** Listen for auth terminal creation - allows UI to display the OAuth terminal */
  onTerminalAuthCreated: (callback: (info: {
    terminalId: string;
    profileId: string;
    profileName: string
  }) => void) => () => void;
  /** Listen for Claude busy state changes (for visual indicator: red=busy, green=idle) */
  onTerminalClaudeBusy: (callback: (id: string, isBusy: boolean) => void) => () => void;
  /** Listen for Claude exit (user closed Claude within terminal, returned to shell) */
  onTerminalClaudeExit: (callback: (id: string) => void) => () => void;
  /** Listen for pending Claude resume notifications (resumed once the window is shown) */
  onTerminalPendingResume: (callback: (id: string) => void) => () => void;
  /** Listen for OAuth code input requests (manual OAuth flow) */
  onTerminalOAuthCodeNeeded: (callback: (info: {
    terminalId: string;
    profileId: string;
    profileName: string
  }) => void) => () => void;
  /** Submit OAuth code from user (for manual OAuth flow) */
  submitOAuthCode: (terminalId: string, code: string) => Promise<IPCResult>;

  // Claude profile management (multi-account support)
  getClaudeProfiles: () => Promise<IPCResult<ClaudeProfileSettings>>;
  saveClaudeProfile: (profile: ClaudeProfile) => Promise<IPCResult<ClaudeProfile>>;
  deleteClaudeProfile: (profileId: string) => Promise<IPCResult>;
  loginClaudeAccount: (profileId?: string) => Promise<IPCResult>;
  redetectClaudeAccounts: () => Promise<IPCResult<ClaudeProfileSettings>>;
  renameClaudeProfile: (profileId: string, newName: string) => Promise<IPCResult>;
  setActiveClaudeProfile: (profileId: string) => Promise<IPCResult>;
  /** Switch terminal to use a different Claude profile (restarts Claude with new config) */
  switchClaudeProfile: (terminalId: string, profileId: string) => Promise<IPCResult>;
  /** Initialize authentication for a Claude profile (legacy - uses hidden terminal) */
  initializeClaudeProfile: (profileId: string) => Promise<IPCResult>;
  /** Set OAuth token for a profile (used when capturing from terminal) */
  setClaudeProfileToken: (profileId: string, token: string, email?: string) => Promise<IPCResult>;
  /** Prepare authentication for a Claude profile - returns terminal config for embedded terminal */
  authenticateClaudeProfile: (profileId: string) => Promise<IPCResult<{ terminalId: string; configDir: string }>>;
  /** Check if a profile has been authenticated (by checking .claude.json) */
  verifyClaudeProfileAuth: (profileId: string) => Promise<IPCResult<{ authenticated: boolean; email?: string }>>;
  /** Run `claude auth login` as a subprocess (no terminal needed) */
  claudeAuthLoginSubprocess: (profileId: string) => Promise<IPCResult<{ authenticated: boolean; email?: string }>>;
  /** Stop a running `claude auth login` (sign-in cancelled or its dialog closed) */
  cancelClaudeAuthLogin: (profileId: string) => Promise<IPCResult>;
  /** Listen for OAuth subprocess progress events */
  onClaudeAuthLoginProgress: (callback: (data: { status: string; message?: string }) => void) => () => void;
  /** Get auto-switch settings */
  getAutoSwitchSettings: () => Promise<IPCResult<ClaudeAutoSwitchSettings>>;
  /** Update auto-switch settings */
  updateAutoSwitchSettings: (settings: Partial<ClaudeAutoSwitchSettings>) => Promise<IPCResult>;
  /** Request usage fetch from a terminal (sends /usage command) */
  fetchClaudeUsage: (terminalId: string) => Promise<IPCResult>;
  /** Get the best available profile (for manual switching) */
  getBestAvailableProfile: (excludeProfileId?: string) => Promise<IPCResult<ClaudeProfile | null>>;
  /** Listen for SDK/CLI rate limit events (non-terminal) */
  /** Listen for auth failure events (401 errors requiring re-authentication) */
  onAuthFailure: (callback: (info: AuthFailureInfo) => void) => () => void;
  /** Retry a rate-limited operation with a different profile */
  retryWithProfile: (request: RetryWithProfileRequest) => Promise<IPCResult>;

  // Usage Monitoring (Proactive Account Switching)
  /** Request current usage snapshot */
  requestUsageUpdate: () => Promise<IPCResult<ClaudeUsageSnapshot | null>>;
  /** Request all profiles usage immediately (for startup/refresh)
   * @param forceRefresh - If true, bypasses cache to get fresh data for all profiles
   */
  requestAllProfilesUsage: (forceRefresh?: boolean) => Promise<IPCResult<AllProfilesUsage | null>>;
  /** Listen for usage data updates */
  /** Usage of the account in use; null right after switching to an account whose usage isn't known yet */
  onUsageUpdated: (callback: (usage: ClaudeUsageSnapshot | null) => void) => () => void;
  /** Listen for proactive swap notifications */
  onProactiveSwapNotification: (callback: (notification: {
    fromProfile: { id: string; name: string };
    toProfile: { id: string; name: string };
    reason: string;
    usageSnapshot: ClaudeUsageSnapshot;
  }) => void) => () => void;
  /** Listen for all profiles usage updates (for multi-profile display) */
  onAllProfilesUsageUpdated?: (callback: (allProfilesUsage: AllProfilesUsage) => void) => () => void;

  // App settings
  getSettings: () => Promise<IPCResult<AppSettings>>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<IPCResult>;

  // Spell check
  setSpellCheckLanguages: (language: string) => Promise<IPCResult<{ success: boolean }>>;

  getCliToolsInfo: () => Promise<IPCResult<{
    python: import('./cli').ToolDetectionResult;
    git: import('./cli').ToolDetectionResult;
    gh: import('./cli').ToolDetectionResult;
    glab: import('./cli').ToolDetectionResult;
    claude: import('./cli').ToolDetectionResult;
  }>>;
  /** Check if Claude Code onboarding is complete (reads ~/.claude.json) */

  // API Profile management (custom Anthropic-compatible endpoints)
  getAPIProfiles: () => Promise<IPCResult<ProfilesFile>>;
  saveAPIProfile: (profile: Omit<APIProfile, 'id' | 'createdAt' | 'updatedAt'>) => Promise<IPCResult<APIProfile>>;
  updateAPIProfile: (profile: APIProfile) => Promise<IPCResult<APIProfile>>;
  deleteAPIProfile: (profileId: string) => Promise<IPCResult>;
  setActiveAPIProfile: (profileId: string | null) => Promise<IPCResult>;
  // Note: AbortSignal is handled in preload via separate cancel IPC channels, not passed through IPC
  testConnection: (baseUrl: string, apiKey: string, signal?: AbortSignal) => Promise<IPCResult<TestConnectionResult>>;
  discoverModels: (baseUrl: string, apiKey: string, signal?: AbortSignal) => Promise<IPCResult<DiscoverModelsResult>>;

  // Dialog operations
  selectDirectory: () => Promise<string | null>;
  createProjectFolder: (location: string, name: string, initGit: boolean) => Promise<IPCResult<CreateProjectFolderResult>>;
  getDefaultProjectLocation: () => Promise<string | null>;

  // App info
  getAppVersion: () => Promise<string>;

  // Electron app update operations
  checkAppUpdate: () => Promise<IPCResult<AppUpdateCheckResult>>;
  downloadAppUpdate: () => Promise<IPCResult>;
  downloadStableUpdate: () => Promise<IPCResult>;
  installAppUpdate: () => void;
  getDownloadedAppUpdate: () => Promise<IPCResult<AppUpdateInfo | null>>;
  skipAppUpdate: (version: string) => Promise<IPCResult>;
  snoozeAppUpdate: () => Promise<IPCResult>;
  isAppUpdateSuppressed: (version: string) => Promise<IPCResult<boolean>>;

  setTitleBarColors: (colors: { color: string; symbolColor: string }) => void;

  // Electron app update event listeners
  onAppUpdateAvailable: (
    callback: (info: AppUpdateAvailableEvent) => void
  ) => () => void;
  onAppUpdateDownloaded: (
    callback: (info: AppUpdateDownloadedEvent) => void
  ) => () => void;
  onAppUpdateProgress: (
    callback: (progress: AppUpdateProgress) => void
  ) => () => void;
  onAppUpdateStableDowngrade: (
    callback: (info: AppUpdateInfo) => void
  ) => () => void;
  onAppUpdateReadOnlyVolume: (
    callback: (info: { appPath: string }) => void
  ) => () => void;
  onAppUpdateError: (
    callback: (error: AppUpdateErrorEvent) => void
  ) => () => void;

  // Shell operations
  openExternal: (url: string) => Promise<void>;
  openTerminal: (dirPath: string) => Promise<IPCResult<void>>;

  // Insights operations
  getInsightsSession: (projectId: string) => Promise<IPCResult<InsightsSession | null>>;
  sendInsightsMessage: (projectId: string, message: string, modelConfig?: InsightsModelConfig, images?: ImageAttachment[]) => void;
  clearInsightsSession: (projectId: string) => Promise<IPCResult>;
  createTaskFromInsights: (
    projectId: string,
    title: string,
    description: string,
    metadata?: TaskMetadata
  ) => Promise<IPCResult<Task>>;
  listInsightsSessions: (projectId: string, includeArchived?: boolean) => Promise<IPCResult<InsightsSessionSummary[]>>;
  newInsightsSession: (projectId: string) => Promise<IPCResult<InsightsSession>>;
  switchInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult<InsightsSession | null>>;
  deleteInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  deleteInsightsSessions: (projectId: string, sessionIds: string[]) => Promise<IPCResult<{ deletedIds: string[]; failedIds: string[] }>>;
  archiveInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  archiveInsightsSessions: (projectId: string, sessionIds: string[]) => Promise<IPCResult<{ archivedIds: string[]; failedIds: string[] }>>;
  unarchiveInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  renameInsightsSession: (projectId: string, sessionId: string, newTitle: string) => Promise<IPCResult>;
  updateInsightsModelConfig: (projectId: string, sessionId: string, modelConfig: InsightsModelConfig) => Promise<IPCResult>;
  /** Full-size image stored for an Insights message, as a data URL */
  getInsightsAttachment: (projectId: string, relativePath: string, mimeType: string) => Promise<IPCResult<string>>;

  // Insights event listeners
  onInsightsStreamChunk: (
    callback: (projectId: string, chunk: InsightsStreamChunk) => void
  ) => () => void;
  onInsightsStatus: (
    callback: (projectId: string, status: InsightsChatStatus) => void
  ) => () => void;
  onInsightsError: (
    callback: (projectId: string, error: string) => void
  ) => () => void;
  onInsightsSessionUpdated: (
    callback: (projectId: string, session: InsightsSession) => void
  ) => () => void;

  // Task logs operations
  getTaskLogs: (projectId: string, specId: string) => Promise<IPCResult<TaskLogs | null>>;
  getPreviousTaskRuns: (projectId: string, specId: string) => Promise<IPCResult<ArchivedTaskRun[]>>;
  watchTaskLogs: (projectId: string, specId: string) => Promise<IPCResult>;
  unwatchTaskLogs: (projectId: string, specId: string) => Promise<IPCResult>;

  // Task logs event listeners
  onTaskLogsChanged: (
    callback: (specId: string, logs: TaskLogs, projectId?: string) => void
  ) => () => void;
  onTaskLogsStream: (
    callback: (specId: string, chunk: TaskLogStreamChunk, projectId?: string) => void
  ) => () => void;
  onMergeProgress: (
    callback: (taskId: string, progress: MergeProgress) => void
  ) => () => void;
  onMergePRProgress: (
    callback: (taskId: string, progress: MergePRProgress) => void
  ) => () => void;
  onLocalMergeProgress: (
    callback: (taskId: string, progress: LocalMergeProgress) => void
  ) => () => void;
  /** Tasks changed outside the board (e.g. by the Claude chat's task tools) */
  onTaskListChanged: (callback: (projectId: string) => void) => () => void;

  // Git operations
  /** @deprecated Will return GitBranchDetail[] in future - see getGitBranchesWithInfo */
  getGitBranches: (projectPath: string) => Promise<IPCResult<string[]>>;
  /** Get branches with structured type information (local vs remote) */
  getGitBranchesWithInfo: (projectPath: string, fetchRemote?: boolean) => Promise<IPCResult<GitBranchDetail[]>>;
  getCurrentGitBranch: (projectPath: string) => Promise<IPCResult<string | null>>;
  detectMainBranch: (projectPath: string) => Promise<IPCResult<string | null>>;
  checkGitStatus: (projectPath: string) => Promise<IPCResult<GitStatus>>;
  initializeGit: (projectPath: string) => Promise<IPCResult<InitializationResult>>;

  // Claude Code CLI operations
  checkClaudeCodeVersion: (forceRefresh?: boolean) => Promise<IPCResult<import('./cli').ClaudeCodeVersionInfo>>;
  installClaudeCode: () => Promise<IPCResult<{ command: string }>>;
  getClaudeCodeVersions: () => Promise<IPCResult<import('./cli').ClaudeCodeVersionList>>;
  installClaudeCodeVersion: (version: string) => Promise<IPCResult<{ command: string; version: string }>>;
  getClaudeCodeInstallations: () => Promise<IPCResult<import('./cli').ClaudeInstallationList>>;
  setClaudeCodeActivePath: (cliPath: string) => Promise<IPCResult<{ path: string }>>;

  // Graphify CLI (memory graph)
  checkGraphifyVersion: (forceRefresh?: boolean) => Promise<IPCResult<import('./cli').GraphifyVersionInfo>>;
  installGraphify: () => Promise<IPCResult<{ command: string }>>;
  getGraphifyIndex: (projectId: string) => Promise<IPCResult<import('./cli').GraphifyIndexInfo | null>>;
  buildGraphifyIndex: (projectId: string) => Promise<IPCResult<import('./cli').GraphifyIndexInfo>>;
  /** The project's CLAUDE.md stats, or null when it has none */
  getProjectIndex: (projectId: string) => Promise<IPCResult<import('./cli').ProjectIndexInfo | null>>;
  /** Give the project a CLAUDE.md: the one set aside while the index was off, else a `/init` run */
  buildProjectIndex: (projectId: string, restore?: boolean) => Promise<IPCResult<import('./cli').ProjectIndexInfo>>;
  /** Whether a project index build is running for the project */
  isProjectIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
  /** Move the project's CLAUDE.md aside, which is what switching Use CLAUDE.md off does */
  stashProjectIndex: (projectId: string) => Promise<IPCResult>;
  /** The project's memory index stats, or null when it has never been built */
  getMemoryIndex: (projectId: string) => Promise<IPCResult<import('./cli').SelfImproveIndexInfo | null>>;
  /** Build (or rebuild) the project's memories from its past Claude Code sessions */
  buildMemoryIndex: (projectId: string) => Promise<IPCResult<import('./cli').SelfImproveIndexInfo>>;
  /** Whether a memory index build is running for the project */
  isMemoryIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
  hasGraphifyGraph: (projectId: string) => Promise<IPCResult<boolean>>;
  isGraphifyEnabled: (projectId: string) => Promise<IPCResult<boolean>>;
  setGraphifyEnabled: (projectId: string, enabled: boolean) => Promise<IPCResult>;
  getGraphifyGraph: (projectId: string) => Promise<IPCResult<import('./cli').GraphifyGraph | null>>;
  onGraphifyIndexUpdated: (callback: (projectId: string, info: import('./cli').GraphifyIndexInfo) => void) => () => void;

  // Live agent (agent windows' agent-flow graph)
  getLiveAgentStatus: () => Promise<IPCResult<import('./live-agent').LiveAgentStatus>>;
  getLiveAgentProject: (projectPath: string) => Promise<IPCResult<boolean>>;
  setLiveAgentProject: (projectPath: string, enabled: boolean) => Promise<IPCResult<{ hooksError?: string }>>;
  subscribeLiveAgent: (clientId: string, cwd: string, projectPath: string, terminalId: string) => Promise<IPCResult>;
  unsubscribeLiveAgent: (clientId: string) => Promise<IPCResult>;
  onLiveAgentStatus: (callback: (status: import('./live-agent').LiveAgentStatus) => void) => () => void;
  onLiveAgentMessage: (callback: (clientId: string, data: string) => void) => () => void;

  // MCP Server health check operations
  checkMcpHealth: (server: CustomMcpServer) => Promise<IPCResult<McpHealthCheckResult>>;
  testMcpConnection: (server: CustomMcpServer) => Promise<IPCResult<McpTestConnectionResult>>;

  // Project windows (one project per window)
  /** Project this window was opened for (null for the first window) */
  assignedProjectId: string | null;
  listProjectWindows: () => Promise<IPCResult<import('./window').ProjectWindowInfo[]>>;
  reportWindowProject: (projectId: string | null) => void;
  openProjectWindow: (projectId: string) => Promise<IPCResult<{ focused: boolean }>>;
  closeProjectWindow: (projectId: string) => Promise<IPCResult>;
  onProjectWindowsChanged: (callback: (windows: import('./window').ProjectWindowInfo[]) => void) => () => void;

  // Windows shell setting (Settings > General)
  /** The value the app started with, the one it runs with, and the last WSL availability check */
  getShellRuntimeStatus: () => Promise<IPCResult<import('./settings').ShellRuntimeStatus>>;
  /** Check WSL availability again */
  refreshWslAvailability: () => Promise<IPCResult<import('./settings').ShellRuntimeStatus>>;
  /** Restart the app (applies a changed shell setting) */
  relaunchApp: () => Promise<IPCResult>;

  // Queue Routing API (rate limit recovery)
  queue: import('../../preload/api/queue-api').QueueAPI;
}

/** Platform information exposed via contextBridge for platform-specific behavior */
interface PlatformInfo {
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
  isUnix: boolean;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    DEBUG: boolean;
    platform?: PlatformInfo;
  }
}
