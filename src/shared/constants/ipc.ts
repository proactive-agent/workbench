/**
 * IPC Channel names for Electron communication
 * Main process <-> Renderer process communication
 */

/**
 * Prefix of the Chromium argument that tells a window which project it was opened for
 * (set as `additionalArguments`, read by the preload script).
 */
export const WINDOW_PROJECT_ARG = '--workbench-project=';

export const IPC_CHANNELS = {
  // Project operations
  PROJECT_ADD: 'project:add',
  PROJECT_REMOVE: 'project:remove',
  PROJECT_LIST: 'project:list',
  PROJECT_COST_METRICS: 'project:costMetrics',  // Task count and total run cost per initialized project
  PROJECT_METRICS_WATCH: 'project:metricsWatch',  // Report changes while the Metrics page is open
  PROJECT_METRICS_UNWATCH: 'project:metricsUnwatch',
  PROJECT_METRICS_CHANGED: 'project:metricsChanged',  // A window spent something, or a session was recorded
  PROJECT_UPDATE_SETTINGS: 'project:updateSettings',
  PROJECT_INITIALIZE: 'project:initialize',
  PROJECT_CHECK_VERSION: 'project:checkVersion',

  // Tab state operations (persisted in main process)
  TAB_STATE_GET: 'tabState:get',
  TAB_STATE_SAVE: 'tabState:save',

  // Kanban preferences (per-project column collapse state)
  KANBAN_PREFS_GET: 'kanbanPrefs:get',
  KANBAN_PREFS_SAVE: 'kanbanPrefs:save',

  // Task operations
  TASK_LIST: 'task:list',
  TASK_CREATE: 'task:create',
  TASK_DELETE: 'task:delete',
  TASK_UPDATE: 'task:update',
  TASK_START: 'task:start',
  TASK_STOP: 'task:stop',
  TASK_RETRY: 'task:retry',  // Start a task over: revert its worktree, reset its spec files, start (or queue) it
  TASK_REVIEW: 'task:review',
  TASK_UPDATE_STATUS: 'task:updateStatus',
  TASK_RECOVER_STUCK: 'task:recoverStuck',
  TASK_CHECK_RUNNING: 'task:checkRunning',
  TASK_LOAD_IMAGE_THUMBNAIL: 'task:loadImageThumbnail',
  TASK_CHECK_WORKTREE_CHANGES: 'task:checkWorktreeChanges',

  // Workspace management (for human review)
  // Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
  TASK_WORKTREE_STATUS: 'task:worktreeStatus',
  TASK_WORKTREE_MERGE: 'task:worktreeMerge',
  TASK_WORKTREE_MERGE_PREVIEW: 'task:worktreeMergePreview',  // Preview merge conflicts before merging
  TASK_WORKTREE_DISCARD: 'task:worktreeDiscard',
  TASK_WORKTREE_CREATE_PR: 'task:worktreeCreatePR',
  TASK_WORKTREE_MERGE_PR: 'task:worktreeMergePR',  // Pull the target into the task branch (Claude Code resolves conflicts), push, merge the PR
  TASK_WORKTREE_MERGE_LOCAL: 'task:worktreeMergeLocal',  // Merge the task branch into its base branch with git, locally (no push)
  TASK_WORKTREE_PR_STATE: 'task:worktreePRState',  // Read a task's PR state from GitHub and store it in the task metadata
  TASK_MERGE_PR_PROGRESS: 'task:mergePRProgress',  // Event: merging a task's PR moved to another step (main -> renderer)
  TASK_MERGE_LOCAL_PROGRESS: 'task:mergeLocalProgress',  // Event: merging a task's branch locally moved to another step (main -> renderer)
  TASK_LIST_WORKTREES: 'task:listWorktrees',
  TASK_ARCHIVE: 'task:archive',
  TASK_UNARCHIVE: 'task:unarchive',
  TASK_CLEAR_STAGED_STATE: 'task:clearStagedState',

  // Task events (main -> renderer)
  TASK_PROGRESS: 'task:progress',
  TASK_ERROR: 'task:error',
  TASK_LOG: 'task:log',
  TASK_STATUS_CHANGE: 'task:statusChange',
  TASK_LIST_CHANGED: 'task:listChanged',  // Event: tasks were created, edited or moved outside the board, e.g. by the Claude chat (main -> renderer): (projectId)
  TASK_RATE_LIMIT_HOLD_CHANGE: 'task:rateLimitHoldChange',  // Rate-limit hold set/cleared (main -> renderer)
  TASK_EXECUTION_PROGRESS: 'task:executionProgress',
  TASK_QUEUE_ORDER_SET: 'task:queueOrderSet',  // Board's saved Queue column order (renderer -> main), used to start the top queued task first
  TASK_CLAUDE_RUN_UPDATE: 'task:claudeRunUpdate',  // Claude Code run state changed (main -> renderer): (taskId, ClaudeRunInfo, projectId)

  // Task phase logs (persistent, collapsible logs by phase)
  TASK_LOGS_GET: 'task:logsGet',           // Load logs from spec dir
  TASK_PREVIOUS_RUNS_GET: 'task:previousRunsGet', // Load the runs the task was started over from
  TASK_LOGS_WATCH: 'task:logsWatch',       // Start watching for log changes
  TASK_LOGS_UNWATCH: 'task:logsUnwatch',   // Stop watching for log changes
  TASK_LOGS_CHANGED: 'task:logsChanged',   // Event: logs changed (main -> renderer)
  TASK_LOGS_STREAM: 'task:logsStream',     // Event: streaming log chunk (main -> renderer)
  TASK_MERGE_PROGRESS: 'task:mergeProgress',  // Event: merge progress update (main -> renderer)

  // Terminal operations
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_INVOKE_CLI: 'terminal:invokeClaude',
  TERMINAL_GENERATE_NAME: 'terminal:generateName',
  TERMINAL_SET_TITLE: 'terminal:setTitle',  // Renderer -> Main: user renamed terminal
  TERMINAL_SET_WORKTREE_CONFIG: 'terminal:setWorktreeConfig',  // Renderer -> Main: worktree association changed

  // Terminal session management
  TERMINAL_GET_SESSIONS: 'terminal:getSessions',
  TERMINAL_RESTORE_SESSION: 'terminal:restoreSession',
  TERMINAL_CLEAR_SESSIONS: 'terminal:clearSessions',
  TERMINAL_RESUME_CLAUDE: 'terminal:resumeClaude',
  TERMINAL_LIST_CLAUDE_SESSIONS: 'terminal:listClaudeSessions',  // The Claude Code sessions an agent window can open (what /resume lists)
  TERMINAL_OPEN_CLAUDE_SESSION: 'terminal:openClaudeSession',  // End the window's session and open another one, or a new one
  TERMINAL_RESUME_TASK_SESSION: 'terminal:resumeTaskSession',  // Resume a task's Claude Code session in an agent window
  TERMINAL_ACTIVATE_DEFERRED_RESUME: 'terminal:activateDeferredResume',  // Resume a restored terminal's Claude Code session once its window is shown
  TERMINAL_CHECK_PTY_ALIVE: 'terminal:checkPtyAlive',
  TERMINAL_UPDATE_DISPLAY_ORDERS: 'terminal:updateDisplayOrders',  // Persist terminal display order after drag-drop reorder

  // Terminal worktree operations (isolated development in worktrees)
  TERMINAL_WORKTREE_CREATE: 'terminal:worktreeCreate',
  TERMINAL_WORKTREE_REMOVE: 'terminal:worktreeRemove',
  TERMINAL_WORKTREE_LIST: 'terminal:worktreeList',
  TERMINAL_WORKTREE_LIST_OTHER: 'terminal:worktreeListOther',

  // Terminal events (main -> renderer)
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_TITLE_CHANGE: 'terminal:titleChange',
  TERMINAL_WORKTREE_CONFIG_CHANGE: 'terminal:worktreeConfigChange',  // Worktree config restored/changed (for sync on recovery)
  TERMINAL_PENDING_RESUME: 'terminal:pendingResume',  // Terminal has a Claude Code session to resume (resumed once its window is shown)
  TERMINAL_RATE_LIMIT: 'terminal:rateLimit',  // Claude Code rate limit detected
  TERMINAL_OAUTH_TOKEN: 'terminal:oauthToken',  // OAuth token captured from setup-token output
  TERMINAL_AUTH_CREATED: 'terminal:authCreated',  // Auth terminal created for OAuth flow
  TERMINAL_OAUTH_CODE_NEEDED: 'terminal:oauthCodeNeeded',  // Request user to paste OAuth code from browser
  TERMINAL_OAUTH_CODE_SUBMIT: 'terminal:oauthCodeSubmit',  // User submitted OAuth code to send to terminal
  TERMINAL_CLAUDE_BUSY: 'terminal:claudeBusy',  // Claude Code busy state (for visual indicator)
  TERMINAL_CLAUDE_EXIT: 'terminal:claudeExit',  // Claude Code exited (returned to shell)

  // Claude profile management (multi-account support)
  CLAUDE_PROFILES_GET: 'claude:profilesGet',
  CLAUDE_PROFILE_SAVE: 'claude:profileSave',
  CLAUDE_PROFILE_DELETE: 'claude:profileDelete',
  CLAUDE_ACCOUNTS_LOGIN: 'claude:accountsLogin',  // Claude Code's sign-in in the user's terminal
  CLAUDE_ACCOUNTS_REDETECT: 'claude:accountsRedetect',  // Detect Claude Code's setups again after a sign-in
  CLAUDE_PROFILE_RENAME: 'claude:profileRename',
  CLAUDE_PROFILE_SET_ACTIVE: 'claude:profileSetActive',
  CLAUDE_PROFILE_SWITCH: 'claude:profileSwitch',
  CLAUDE_PROFILE_INITIALIZE: 'claude:profileInitialize',
  CLAUDE_PROFILE_SET_TOKEN: 'claude:profileSetToken',  // Set OAuth token for a profile
  CLAUDE_PROFILE_AUTHENTICATE: 'claude:profileAuthenticate',  // Open visible terminal for OAuth login
  CLAUDE_PROFILE_VERIFY_AUTH: 'claude:profileVerifyAuth',  // Check if profile has been authenticated
  CLAUDE_AUTH_LOGIN_SUBPROCESS: 'claude:authLoginSubprocess',  // Run `claude auth login` as subprocess
  CLAUDE_AUTH_LOGIN_PROGRESS: 'claude:authLoginProgress',      // Main → Renderer progress events
  CLAUDE_AUTH_LOGIN_CANCEL: 'claude:authLoginCancel',          // Stop a running `claude auth login`
  CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS: 'claude:autoSwitchSettings',
  CLAUDE_PROFILE_UPDATE_AUTO_SWITCH: 'claude:updateAutoSwitch',
  CLAUDE_PROFILE_FETCH_USAGE: 'claude:fetchUsage',
  CLAUDE_PROFILE_GET_BEST_PROFILE: 'claude:getBestProfile',

  // SDK/CLI rate limit event (for non-terminal Claude invocations)
  CLAUDE_SDK_RATE_LIMIT: 'claude:sdkRateLimit',
  // Auth failure event (401 errors requiring re-authentication)
  CLAUDE_AUTH_FAILURE: 'claude:authFailure',
  // Retry a rate-limited operation with a different profile
  CLAUDE_RETRY_WITH_PROFILE: 'claude:retryWithProfile',

  // Usage monitoring (proactive account switching)
  USAGE_UPDATED: 'claude:usageUpdated',  // Event: usage data updated (main -> renderer)
  USAGE_REQUEST: 'claude:usageRequest',  // Request current usage snapshot
  ALL_PROFILES_USAGE_REQUEST: 'claude:allProfilesUsageRequest',  // Request all profiles usage immediately
  ALL_PROFILES_USAGE_UPDATED: 'claude:allProfilesUsageUpdated',  // Event: all profiles usage data (main -> renderer)
  PROACTIVE_SWAP_NOTIFICATION: 'claude:proactiveSwapNotification',  // Event: proactive swap occurred

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_GET_CLI_TOOLS_INFO: 'settings:getCliToolsInfo',

  // API Profile management (custom Anthropic-compatible endpoints)
  PROFILES_GET: 'profiles:get',
  PROFILES_SAVE: 'profiles:save',
  PROFILES_UPDATE: 'profiles:update',
  PROFILES_DELETE: 'profiles:delete',
  PROFILES_SET_ACTIVE: 'profiles:setActive',
  PROFILES_TEST_CONNECTION: 'profiles:test-connection',
  PROFILES_TEST_CONNECTION_CANCEL: 'profiles:test-connection-cancel',
  PROFILES_DISCOVER_MODELS: 'profiles:discover-models',
  PROFILES_DISCOVER_MODELS_CANCEL: 'profiles:discover-models-cancel',

  // Dialogs
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  DIALOG_CREATE_PROJECT_FOLDER: 'dialog:createProjectFolder',
  DIALOG_GET_DEFAULT_PROJECT_LOCATION: 'dialog:getDefaultProjectLocation',

  // App info
  APP_VERSION: 'app:version',
  WINDOW_SET_TITLE_BAR_COLORS: 'window:setTitleBarColors', // Match the window controls to the theme: ({ color, symbolColor }) (renderer -> main)

  // Project windows (one window per project)
  WINDOW_LIST_PROJECTS: 'window:listProjects',       // Every open window with the project it shows
  WINDOW_REPORT_PROJECT: 'window:reportProject',     // The window tells main which project it shows (renderer -> main)
  WINDOW_OPEN_PROJECT: 'window:openProject',         // Open a project in a new window (or focus the one showing it)
  WINDOW_CLOSE_PROJECT: 'window:closeProject',       // Close the window showing a project ("Quit window")
  WINDOW_PROJECTS_CHANGED: 'window:projectsChanged', // Event: the open windows changed (main -> renderer)
  PROJECT_LIST_CHANGED: 'project:listChanged',       // Event: a project was added or removed (main -> renderer)

  // Shell operations
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_OPEN_TERMINAL: 'shell:openTerminal',

  // Insights operations
  INSIGHTS_GET_SESSION: 'insights:getSession',
  INSIGHTS_SEND_MESSAGE: 'insights:sendMessage',
  INSIGHTS_CLEAR_SESSION: 'insights:clearSession',
  INSIGHTS_CREATE_TASK: 'insights:createTask',
  INSIGHTS_LIST_SESSIONS: 'insights:listSessions',
  INSIGHTS_NEW_SESSION: 'insights:newSession',
  INSIGHTS_SWITCH_SESSION: 'insights:switchSession',
  INSIGHTS_DELETE_SESSION: 'insights:deleteSession',
  INSIGHTS_DELETE_SESSIONS: 'insights:deleteSessions',
  INSIGHTS_ARCHIVE_SESSION: 'insights:archiveSession',
  INSIGHTS_ARCHIVE_SESSIONS: 'insights:archiveSessions',
  INSIGHTS_UNARCHIVE_SESSION: 'insights:unarchiveSession',
  INSIGHTS_RENAME_SESSION: 'insights:renameSession',
  INSIGHTS_UPDATE_MODEL_CONFIG: 'insights:updateModelConfig',
  INSIGHTS_GET_ATTACHMENT: 'insights:getAttachment',

  // Insights events (main -> renderer)
  INSIGHTS_STREAM_CHUNK: 'insights:streamChunk',
  INSIGHTS_STATUS: 'insights:status',
  INSIGHTS_ERROR: 'insights:error',
  INSIGHTS_SESSION_UPDATED: 'insights:sessionUpdated',  // Event: session updated (main -> renderer)

  // Git operations
  GIT_GET_BRANCHES: 'git:getBranches',
  GIT_GET_BRANCHES_WITH_INFO: 'git:getBranchesWithInfo',
  GIT_GET_CURRENT_BRANCH: 'git:getCurrentBranch',
  GIT_DETECT_MAIN_BRANCH: 'git:detectMainBranch',
  GIT_CHECK_STATUS: 'git:checkStatus',
  GIT_INITIALIZE: 'git:initialize',

  // Windows shell (Settings > General): runtime status, WSL availability, relaunch to apply
  SHELL_RUNTIME_GET_STATUS: 'shellRuntime:getStatus',     // Saved value at startup, value in use, last WSL check
  SHELL_RUNTIME_REFRESH_WSL: 'shellRuntime:refreshWsl',   // Check WSL availability again
  APP_RELAUNCH: 'app:relaunch',                           // Restart the app (quits through the normal quit path)

  // App auto-update operations
  APP_UPDATE_CHECK: 'app-update:check',
  APP_UPDATE_DOWNLOAD: 'app-update:download',
  APP_UPDATE_DOWNLOAD_STABLE: 'app-update:download-stable',  // Download stable version (for downgrade from beta)
  APP_UPDATE_INSTALL: 'app-update:install',
  APP_UPDATE_GET_VERSION: 'app-update:get-version',
  APP_UPDATE_GET_DOWNLOADED: 'app-update:get-downloaded',  // Get downloaded update info (for showing Install button on Settings open)
  APP_UPDATE_SKIP_VERSION: 'app-update:skip-version',  // Skip a specific version permanently
  APP_UPDATE_SNOOZE: 'app-update:snooze',  // Snooze update notifications for 24 hours
  APP_UPDATE_IS_SUPPRESSED: 'app-update:is-suppressed',  // Check if update notifications are suppressed

  // App auto-update events (main -> renderer)
  APP_UPDATE_AVAILABLE: 'app-update:available',
  APP_UPDATE_DOWNLOADED: 'app-update:downloaded',
  APP_UPDATE_PROGRESS: 'app-update:progress',
  APP_UPDATE_ERROR: 'app-update:error',
  APP_UPDATE_STABLE_DOWNGRADE: 'app-update:stable-downgrade',  // Stable version available for downgrade from beta
  APP_UPDATE_READONLY_VOLUME: 'app-update:readonly-volume',  // App running from read-only volume (DMG), needs to be moved

  // Debug operations

  // Claude Code CLI operations
  CLAUDE_CODE_CHECK_VERSION: 'claudeCode:checkVersion',
  CLAUDE_CODE_INSTALL: 'claudeCode:install',
  CLAUDE_CODE_GET_VERSIONS: 'claudeCode:getVersions',
  CLAUDE_CODE_INSTALL_VERSION: 'claudeCode:installVersion',
  CLAUDE_CODE_GET_INSTALLATIONS: 'claudeCode:getInstallations',
  CLAUDE_CODE_SET_ACTIVE_PATH: 'claudeCode:setActivePath',

  // Graphify CLI (memory graph)
  GRAPHIFY_CHECK_VERSION: 'graphify:checkVersion',
  GRAPHIFY_INSTALL: 'graphify:install',
  GRAPHIFY_GET_INDEX: 'graphify:getIndex',
  GRAPHIFY_BUILD_INDEX: 'graphify:buildIndex',

  // Self-improve: the project's memory index, built from its past sessions
  // Project index (the project's CLAUDE.md, written by /init)
  PROJECT_INDEX_GET: 'projectIndex:get',
  PROJECT_INDEX_BUILD: 'projectIndex:build',
  PROJECT_INDEX_IS_BUILDING: 'projectIndex:isBuilding',
  PROJECT_INDEX_STASH: 'projectIndex:stash',

  SELF_IMPROVE_GET_INDEX: 'selfImprove:getIndex',
  SELF_IMPROVE_BUILD_INDEX: 'selfImprove:buildIndex',
  SELF_IMPROVE_IS_BUILDING: 'selfImprove:isBuilding',
  GRAPHIFY_HAS_GRAPH: 'graphify:hasGraph',
  GRAPHIFY_IS_ENABLED: 'graphify:isEnabled',
  GRAPHIFY_SET_ENABLED: 'graphify:setEnabled',
  GRAPHIFY_GET_GRAPH: 'graphify:getGraph',
  GRAPHIFY_INDEX_UPDATED: 'graphify:indexUpdated', // main -> renderer: a project's graph was rebuilt

  // Live agent (agent windows' agent-flow graph)
  LIVE_AGENT_GET_STATUS: 'liveAgent:getStatus',
  LIVE_AGENT_GET_PROJECT: 'liveAgent:getProject',
  LIVE_AGENT_SET_PROJECT: 'liveAgent:setProject',
  LIVE_AGENT_SUBSCRIBE: 'liveAgent:subscribe',
  LIVE_AGENT_UNSUBSCRIBE: 'liveAgent:unsubscribe',
  LIVE_AGENT_STATUS: 'liveAgent:status',   // main -> renderer: the relay started, stopped or failed
  LIVE_AGENT_MESSAGE: 'liveAgent:message', // main -> renderer: a relay message for one graph

  // MCP Server health checks
  MCP_CHECK_HEALTH: 'mcp:checkHealth',           // Quick connectivity check
  MCP_TEST_CONNECTION: 'mcp:testConnection',     // Full MCP protocol test


  // Spell check
  SPELLCHECK_SET_LANGUAGES: 'spellcheck:setLanguages',  // Set spell check language (syncs with i18n)

  // Queue routing (rate limit recovery)
  QUEUE_GET_RUNNING_TASKS_BY_PROFILE: 'queue:getRunningTasksByProfile',
  QUEUE_GET_BEST_PROFILE_FOR_TASK: 'queue:getBestProfileForTask',
  QUEUE_GET_BEST_UNIFIED_ACCOUNT: 'queue:getBestUnifiedAccount', // Unified OAuth + API account selection
  QUEUE_ASSIGN_PROFILE_TO_TASK: 'queue:assignProfileToTask',
  QUEUE_UPDATE_TASK_SESSION: 'queue:updateTaskSession',
  QUEUE_GET_TASK_SESSION: 'queue:getTaskSession',

  // Queue routing events (main -> renderer)
  QUEUE_PROFILE_SWAPPED: 'queue:profileSwapped',      // Task switched to different profile
  QUEUE_SESSION_CAPTURED: 'queue:sessionCaptured',    // Session ID captured from running task
  QUEUE_BLOCKED_NO_PROFILES: 'queue:blockedNoProfiles' // All profiles unavailable
} as const;
