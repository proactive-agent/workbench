/**
 * Terminal-related types
 */

/**
 * The kind of shell an agent window runs, which decides the syntax of every command the app types
 * into it (changing directory, quoting, environment variables, chaining):
 * - 'posix': bash, zsh, fish and other Unix shells (single quotes, `VAR=value cmd`, `&&`)
 * - 'cmd': cmd.exe and the other Windows shells that accept its syntax (`cd /d "..."`, `set "VAR=..."`, `&&`)
 * - 'powershell': PowerShell 7 (pwsh.exe) and Windows PowerShell 5.1 (`Set-Location -LiteralPath '...'`,
 *   `$env:VAR = '...'`, `& 'cmd'`; chained with ';' since 5.1 has no '&&')
 */
export type ShellKind = 'cmd' | 'powershell' | 'posix';

export interface TerminalCreateOptions {
  id: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  /** Skip injecting OAuth token into terminal environment (used for auth terminals) */
  skipOAuthToken?: boolean;
  /** Custom environment variables to add to the terminal (merged with defaults) */
  env?: Record<string, string>;
}

/**
 * Persisted terminal session data for restoring sessions on app restart
 */
export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  projectPath: string;
  isCLIMode: boolean;
  outputBuffer: string;
  createdAt: string;
  lastActiveAt: string;
  /** Display order for tab persistence (lower = further left) */
  displayOrder?: number;
  /** Associated worktree configuration (validated on restore) */
  worktreeConfig?: TerminalWorktreeConfig;
}

export interface TerminalRestoreResult {
  success: boolean;
  terminalId: string;
  outputBuffer?: string;  // For replay in UI
  error?: string;
}



/**
 * Rate limit information for SDK/CLI calls (non-terminal)
 * Used for task execution, title generation, etc.
 */
export interface SDKRateLimitInfo {
  /** Source of the rate limit (which feature hit it) */
  source: 'task' | 'title-generator' | 'other';
  /** Project ID if applicable */
  projectId?: string;
  /** Task ID if applicable */
  taskId?: string;
  /** The reset time string (e.g., "Dec 17 at 6am (Europe/Oslo)") */
  resetTime?: string;
  /** Type of limit: 'session' (5-hour) or 'weekly' (7-day) */
  limitType?: 'session' | 'weekly';
  /** Profile that hit the limit */
  profileId: string;
  /** Profile name for display */
  profileName?: string;
  /** Suggested alternative profile */
  suggestedProfile?: {
    id: string;
    name: string;
  };
  /** When detected */
  detectedAt: Date;
  /** Original error message */
  originalError?: string;

  // Auto-swap information (NEW)
  /** Whether this rate limit was automatically handled via account swap */
  wasAutoSwapped?: boolean;
  /** Profile that was swapped to (if auto-swapped) */
  swappedToProfile?: {
    id: string;
    name: string;
  };
  /** Why the swap occurred: 'proactive' (before limit) or 'reactive' (after limit hit) */
  swapReason?: 'proactive' | 'reactive';
}

/**
 * Authentication failure information for SDK/CLI operations.
 * Emitted when Claude CLI encounters a 401 or other auth error,
 * indicating the token needs to be refreshed via re-authentication.
 */
export interface AuthFailureInfo {
  /** The profile ID that failed to authenticate */
  profileId: string;
  /** The profile name for display */
  profileName?: string;
  /** Type of auth failure */
  failureType: 'missing' | 'invalid' | 'expired' | 'unknown';
  /** User-friendly message describing the failure */
  message: string;
  /** Original error message from the process output */
  originalError?: string;
  /** Task ID if applicable (for task-related auth failures) */
  taskId?: string;
  /** When detected (Note: serialized as ISO string over IPC) */
  detectedAt: Date;
}

/**
 * Request to retry a rate-limited operation with a different profile
 */
export interface RetryWithProfileRequest {
  /** Source of the original operation */
  source: SDKRateLimitInfo['source'];
  /** Project ID */
  projectId: string;
  /** Task ID if applicable */
  taskId?: string;
  /** Profile ID to retry with */
  profileId: string;
}

// ============================================================================
// Terminal Worktree Types
// ============================================================================

/**
 * Configuration for a terminal-associated git worktree
 * Enables isolated development environments for each terminal session
 */
export interface TerminalWorktreeConfig {
  /** Unique worktree name (used as directory name) */
  name: string;
  /** Path to the worktree directory (.workbench/worktrees/terminal/{name}/) */
  worktreePath: string;
  /** Git branch name (terminal/{name}) - empty if no branch created */
  branchName: string;
  /** Base branch the worktree was created from (from project settings or auto-detected) */
  baseBranch: string;
  /** Whether a git branch was created for this worktree */
  hasGitBranch: boolean;
  /** Associated task ID (optional - for task-linked worktrees) */
  taskId?: string;
  /** When the worktree was created */
  createdAt: string;
  /** Terminal ID this worktree is associated with */
  terminalId: string;
  /** Whether the branch was pushed to remote with tracking set up */
  remoteTrackingSetUp?: boolean;
}

/**
 * Request to create a terminal worktree
 */
export interface CreateTerminalWorktreeRequest {
  /** Terminal ID to associate with */
  terminalId: string;
  /** Worktree name (alphanumeric, dashes, underscores only) */
  name: string;
  /** Optional task ID to link */
  taskId?: string;
  /** Whether to create a git branch (terminal/{name}) */
  createGitBranch: boolean;
  /** Project path where the worktree will be created */
  projectPath: string;
  /** Optional base branch to create worktree from (defaults to project default) */
  baseBranch?: string;
  /**
   * When true, use the local branch directly without auto-switching to remote.
   * This preserves gitignored files (.env, configs) that may not exist on remote.
   * When false or undefined, the default behavior prefers origin/branch if it exists.
   */
  useLocalBranch?: boolean;
}

/**
 * Result of terminal worktree creation
 */
export interface TerminalWorktreeResult {
  success: boolean;
  config?: TerminalWorktreeConfig;
  error?: string;
  /** Warning when worktree was created but remote push failed */
  warning?: string;
}

/**
 * Information about a worktree not managed by Workbench
 * Discovered via `git worktree list` excluding Workbench paths
 */
export interface OtherWorktreeInfo {
  /** Full path to the worktree */
  path: string;
  /** Git branch name, or null if in detached HEAD state */
  branch: string | null;
  /** Short commit SHA (first 8 chars) */
  commitSha: string;
  /** Display name (last directory component of path) */
  displayName: string;
}

/** A Claude Code session an agent window can open: what `/resume` lists in its directory */
export interface ClaudeSessionItem {
  sessionId: string;
  /** Its title (one set for it, else the one Claude gave it, else its name or latest prompt) */
  name?: string;
  /** When its transcript last changed (ms) */
  modifiedAt: number;
  /** The session the window has open (or last had) */
  current: boolean;
}
