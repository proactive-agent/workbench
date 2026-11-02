/**
 * Project-related types
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  autoBuildPath: string;
  settings: ProjectSettings;
  createdAt: Date;
  updatedAt: Date;
}

/** What a project spent on one calendar day */
export interface ProjectDailyCost {
  /** Local calendar day, `YYYY-MM-DD` */
  date: string;
  costUsd: number;
}

/** Spending of one initialized project (Settings > Accounts > Metrics) */
export interface ProjectCostMetrics {
  projectId: string;
  name: string;
  path: string;
  /** Tasks (spec directories) in the project */
  taskCount: number;
  /** Sum of the tasks' Claude Code run costs (USD) */
  totalCostUsd: number;
  /** Spending per day, oldest first; days without spending are left out */
  daily: ProjectDailyCost[];
}

export interface ProjectSettings {
  model: string;
  notifications: NotificationSettings;
  /** Main branch name for worktree creation (default: auto-detected or 'main') */
  mainBranch?: string;
  /** Whether newly created branches should be pushed to origin and track their remote branch (default: true) */
  pushNewBranches?: boolean;
  /** Include CLAUDE.md instructions in agent system prompt (default: true) */
  useClaudeMd?: boolean;
  /** Stop a task once its estimated spend reaches this amount (`--max-budget-usd`); unset = no cap */
  maxBudgetUsd?: number;
  /** Claude account (profile id) the project's tasks and chats run on; unset = the account in use */
  claudeProfileId?: string;
  /** Maximum parallel tasks allowed (default: 3) */
  maxParallelTasks?: number;
  /**
   * Let sessions save what they learn about this project (Claude Code's auto memory, relocated to
   * `.workbench/compeng` so every session in the project shares it); off unless set
   */
  selfImprove?: boolean;
}

export interface NotificationSettings {
  onTaskComplete: boolean;
  onTaskFailed: boolean;
  onReviewNeeded: boolean;
  sound: boolean;
}

/**
 * Custom MCP server configuration.
 * Users can add command-based (npx/npm) or HTTP-based servers.
 */
export interface CustomMcpServer {
  /** Unique identifier */
  id: string;
  /** Display name shown in UI */
  name: string;
  /** Server type */
  type: 'command' | 'http';
  /** Command to execute (for type: 'command'). e.g., 'npx', 'npm', 'node' */
  command?: string;
  /** Arguments for the command (for type: 'command'). e.g., ['-y', 'my-mcp-server'] */
  args?: string[];
  /** HTTP URL (for type: 'http'). e.g., 'https://mcp.example.com/mcp' */
  url?: string;
  /** HTTP headers (for type: 'http'). e.g., { "Authorization": "Bearer ..." } */
  headers?: Record<string, string>;
  /** Optional description shown in UI */
  description?: string;
  /** Set once a connection test passes; the row then shows an on/off switch instead of Test */
  verified?: boolean;
  /** Whether agents get this server (default true) */
  enabled?: boolean;
}

/**
 * MCP server health check status.
 */
export type McpHealthStatus = 'healthy' | 'unhealthy' | 'needs_auth' | 'unknown' | 'checking';

/**
 * Whether a connector's MCP server can start (src/main/mcp-availability.ts): preparing while its
 * first start downloads it, ready once it answered, unavailable with the missing command or why
 */
export interface McpAvailability {
  state: 'preparing' | 'ready' | 'unavailable';
  /** The command the server needs, when it isn't installed */
  missingCommand?: string;
  /** Why it couldn't start */
  message?: string;
  /** A command that makes it usable (e.g. installing Playwright's browser) */
  fixCommand?: string;
  /** Playwright's chosen browser is open: runs can't copy its profile until it is closed */
  browserOpen?: boolean;
}

/**
 * Result of a quick health check for a custom MCP server.
 */
export interface McpHealthCheckResult {
  /** Server ID */
  serverId: string;
  /** Health status */
  status: McpHealthStatus;
  /** HTTP status code (for HTTP servers) */
  statusCode?: number;
  /** Human-readable message */
  message?: string;
  /** Response time in milliseconds */
  responseTime?: number;
  /** Timestamp of the check */
  checkedAt: string;
}

/**
 * Result of a full MCP connection test.
 */
export interface McpTestConnectionResult {
  /** Server ID */
  serverId: string;
  /** Whether the connection was successful */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** Detailed error if any */
  error?: string;
  /** List of tools discovered (for successful connections) */
  tools?: string[];
  /** Response time in milliseconds */
  responseTime?: number;
}

// Workbench Initialization Types
export interface AutoBuildVersionInfo {
  isInitialized: boolean;
  updateAvailable: boolean; // Always false - .workbench only contains data, no code to update
}

export interface InitializationResult {
  success: boolean;
  error?: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  hasCommits: boolean;
  currentBranch: string | null;
  error?: string;
}

export interface CreateProjectFolderResult {
  path: string;
  name: string;
  gitInitialized: boolean;
}
