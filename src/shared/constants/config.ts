/**
 * Application configuration constants
 * Default settings, file paths, and project structure
 */

// ============================================
// Terminal Timing Constants
// ============================================

/** Delay for DOM updates before terminal operations (refit, resize).
 * Must be long enough for dnd-kit CSS transitions to complete after drag-drop reorder.
 * 50ms was too short, causing xterm to fit into containers with zero/invalid dimensions. */
export const TERMINAL_DOM_UPDATE_DELAY_MS = 250;

/** Grace period before cleaning up error panel constraints after panel removal */
export const PANEL_CLEANUP_GRACE_PERIOD_MS = 150;

// ============================================
// UI Scale Constants
// ============================================

/**
 * Height (px) of the window-controls strip on Windows/Linux, where the OS title bar is hidden
 * and Electron draws minimize/maximize/close over the top-right corner of the app
 */
export const TITLE_BAR_OVERLAY_HEIGHT = 40;

export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_PRESETS = [100, 125, 150] as const;

/** The UI scale to apply: one of the presets, otherwise the 100% default */
export function normalizeUiScale(scale: number | undefined): number {
  return UI_SCALE_PRESETS.some((preset) => preset === scale) ? (scale as number) : UI_SCALE_DEFAULT;
}

// ============================================
// Default App Settings
// ============================================

// Agent terminals per project. The cap guards against excessive memory use from terminal
// buffers (~1MB each) and PTY process resource exhaustion.
export const DEFAULT_MAX_TERMINALS = 12;
export const MIN_TERMINALS = 1;
export const MAX_TERMINALS_LIMIT = 24;

export const DEFAULT_APP_SETTINGS = {
  theme: 'dark' as const,
  colorTheme: 'default' as const,
  defaultModel: 'opus',
  pythonPath: undefined as string | undefined,
  gitPath: undefined as string | undefined,
  githubCLIPath: undefined as string | undefined,
  gitlabCLIPath: undefined as string | undefined,
  autoBuildPath: undefined as string | undefined,
  autoUpdateAutoBuild: true,
  maxTerminals: DEFAULT_MAX_TERMINALS,
  onboardingCompleted: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Global API keys (used as defaults for all projects)
  globalOpenAIApiKey: undefined as string | undefined,
  // Selected agent profile - defaults to 'auto' for per-phase optimized model selection
  selectedAgentProfile: 'auto',
  // UI Scale (default 100% - standard size)
  uiScale: UI_SCALE_DEFAULT,
  // Log order setting for task detail view (default chronological - oldest first)
  logOrder: 'chronological' as const,
  // Beta updates opt-in (receive pre-release versions)
  betaUpdates: false,
  // Anonymous error reporting (Sentry) - enabled by default to help improve the app
  sentryEnabled: true,
  // Auto-name Claude terminals based on initial message (enabled by default)
  // GPU acceleration for terminal rendering
  // Default to 'off' until WebGL stability is proven across all GPU drivers.
  // Users can opt-in via Settings > Display > GPU Acceleration.
  gpuAcceleration: 'off' as const
};

// ============================================
// Default Project Settings
// ============================================

export const DEFAULT_PROJECT_SETTINGS = {
  model: 'opus',
  memoryBackend: 'file' as const,
  linearSync: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    sound: false
  },
  // Include CLAUDE.md instructions in agent context (enabled by default)
  useClaudeMd: true
};

// ============================================
// Auto Build File Paths
// ============================================

// File paths relative to project
// IMPORTANT: All paths use .auto-claude/ (the installed instance), NOT auto-claude/ (source code)
export const AUTO_BUILD_PATHS = {
  SPECS_DIR: '.auto-claude/specs',
  IMPLEMENTATION_PLAN: 'implementation_plan.json',
  SPEC_FILE: 'spec.md',
  QA_REPORT: 'qa_report.md',
  BUILD_PROGRESS: 'build-progress.txt',
  CONTEXT: 'context.json',
  REQUIREMENTS: 'requirements.json',
  PROJECT_INDEX: '.auto-claude/project_index.json',
  MEMORY_STATE: '.memory_state.json'
} as const;

/**
 * Get the specs directory path.
 * All specs go to .auto-claude/specs/ (the project's data directory).
 */
export function getSpecsDir(autoBuildPath: string | undefined): string {
  const basePath = autoBuildPath || '.auto-claude';
  return `${basePath}/specs`;
}
