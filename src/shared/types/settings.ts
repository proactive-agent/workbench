/**
 * Application settings types
 */

import type { NotificationSettings, CustomMcpServer } from './project';
import type { ClaudeCodeTaskSettings } from './claude-code';
import type { PlaywrightBrowserChoice } from './browser-profiles';

// Color theme types for multi-theme support
export type ColorTheme = 'default';

/**
 * MCP connector defaults (Settings > Connectors). New tasks start from these and can change them
 * per task (TaskMetadata.mcpConnectors) without affecting the defaults or other tasks.
 */
export interface McpConnectorSettings {
  /** Context7 documentation lookup (default on) */
  context7Enabled?: boolean;
  /** Electron automation (default off) */
  electronEnabled?: boolean;
  /** Playwright browser automation (default off) */
  playwrightEnabled?: boolean;
  /** The browser Playwright uses (unset: Playwright's own Chromium with a blank profile) */
  playwrightBrowser?: PlaywrightBrowserChoice;
  /** User-added servers; only ones that passed a connection test can be used */
  customServers?: CustomMcpServer[];
}

/** Interface font choice (Appearance settings) */
export type InterfaceFont = 'anthropic-sans' | 'system' | 'sans-serif' | 'inter';

/** How the Graph page draws the memory graph: one muted color, or Graphify's community colors */
export type GraphStyle = 'plain' | 'colorful';

/**
 * Shell Workbench uses on Windows (Settings > General): native tools with PowerShell agent windows,
 * or everything inside WSL's default distribution. Takes effect after a restart; undefined means pwsh.
 */
export type WindowsShell = 'pwsh' | 'wsl';

/** Why WSL can't be used: not Windows, WSL not installed, no Linux distribution, no answer in time, other error */
export type WslUnavailableReason = 'not-windows' | 'not-installed' | 'no-distro' | 'timeout' | 'error';

/** Result of checking whether WSL can run Workbench's tools (`wsl.exe -l`, doesn't start the VM) */
export interface WslAvailability {
  available: boolean;
  /** Set when not available */
  reason?: WslUnavailableReason;
  /** wsl.exe's own message or the error, when there is one */
  detail?: string;
  /** Usable distributions (Docker/Rancher Desktop's own ones left out) */
  distros: string[];
  /** The distribution Workbench uses: WSL's default one */
  defaultDistro?: string;
  /** WSL version of the default distribution (1 or 2) */
  version?: number;
  /** When the check ran (ms since epoch) */
  checkedAt: number;
}

/** Why a session configured for WSL runs natively instead */
export type ShellFallbackReason = 'wsl-unavailable' | 'probe-failed';

/** The shell setting the app was started with and the one it runs with (Settings > General) */
export interface ShellRuntimeStatus {
  /** Whether the setting applies (Windows only) */
  supported: boolean;
  /** Whether startup detection finished */
  ready: boolean;
  /** The saved value when the app started */
  configured: WindowsShell;
  /** The value this session runs with ('pwsh' after a fallback) */
  active: WindowsShell;
  /** Last WSL availability check, null when it hasn't run */
  wsl: WslAvailability | null;
  fallbackReason?: ShellFallbackReason;
  fallbackDetail?: string;
  /** Distribution in use when active is 'wsl' */
  distro?: string;
  /**
   * In WSL: Windows git and WSL git convert line endings differently (core.autocrlf), so the
   * same checkout can show every file as changed in one of them. Values as configured ('unset'
   * when not set)
   */
  autocrlfMismatch?: { windows: string; wsl: string };
}

/**
 * Custom tool paths inside WSL (Linux paths such as /usr/bin/git), used instead of pythonPath,
 * gitPath... while the app runs its tools in WSL, so switching shells never mixes the two sets
 */
export interface WslToolPaths {
  claude?: string;
  git?: string;
  gh?: string;
  glab?: string;
  python?: string;
  node?: string;
}

// Developer tools preferences - IDE and terminal selection
// Comprehensive list based on Stack Overflow Developer Survey 2024, JetBrains Survey, and market research
type SupportedIDE =
  // Microsoft/VS Code Ecosystem
  | 'vscode'           // Visual Studio Code (~73% market share)
  | 'visualstudio'     // Visual Studio (full IDE)
  | 'vscodium'         // VSCodium (OSS VS Code without telemetry)
  // AI-Powered Editors (VS Code forks & alternatives)
  | 'cursor'           // Cursor (AI-first VS Code fork)
  | 'windsurf'         // Windsurf by Codeium (AI editor)
  | 'zed'              // Zed (high-performance, Rust-based, AI features)
  | 'void'             // Void (open-source AI editor)
  | 'pearai'           // PearAI (open-source AI editor)
  | 'kiro'             // Kiro by AWS (spec-driven agentic IDE)
  // JetBrains IDEs
  | 'intellij'         // IntelliJ IDEA
  | 'pycharm'          // PyCharm
  | 'webstorm'         // WebStorm
  | 'phpstorm'         // PhpStorm
  | 'rubymine'         // RubyMine
  | 'goland'           // GoLand
  | 'clion'            // CLion (C/C++)
  | 'rider'            // Rider (.NET)
  | 'datagrip'         // DataGrip (Database)
  | 'fleet'            // Fleet (lightweight)
  | 'androidstudio'    // Android Studio (based on IntelliJ)
  | 'aqua'             // Aqua (test automation)
  | 'rustrover'        // RustRover (Rust IDE)
  // Classic Text Editors
  | 'sublime'          // Sublime Text
  | 'vim'              // Vim
  | 'neovim'           // Neovim
  | 'emacs'            // Emacs
  | 'nano'             // GNU Nano
  | 'micro'            // Micro (modern terminal editor)
  | 'helix'            // Helix (modal editor, Rust-based)
  | 'kakoune'          // Kakoune (modal editor)
  // Platform-Specific IDEs
  | 'xcode'            // Xcode (Apple)
  | 'eclipse'          // Eclipse
  | 'netbeans'         // NetBeans
  | 'qtcreator'        // Qt Creator
  | 'codeblocks'       // Code::Blocks
  // macOS-Specific Editors
  | 'nova'             // Nova by Panic
  | 'bbedit'           // BBEdit
  | 'textmate'         // TextMate
  | 'coteditor'        // CotEditor
  // Windows-Specific Editors
  | 'notepadpp'        // Notepad++
  | 'ultraedit'        // UltraEdit
  // Linux Editors
  | 'kate'             // Kate (KDE)
  | 'gedit'            // gedit (GNOME)
  | 'geany'            // Geany
  | 'lapce'            // Lapce (Rust-based, fast)
  | 'lite-xl'          // Lite XL (lightweight)
  // Cloud/Browser-Based IDEs
  | 'codespaces'       // GitHub Codespaces
  | 'gitpod'           // Gitpod
  | 'replit'           // Replit
  | 'codesandbox'      // CodeSandbox
  | 'stackblitz'       // StackBlitz
  | 'cloud9'           // AWS Cloud9
  | 'cloudshell'       // Google Cloud Shell Editor
  | 'coder'            // Coder (self-hosted)
  | 'glitch'           // Glitch
  | 'codepen'          // CodePen
  | 'jsfiddle'         // JSFiddle
  | 'colab'            // Google Colab (notebooks)
  | 'jupyter'          // Jupyter/JupyterLab
  | 'dataspell'        // DataSpell (JetBrains data science)
  // Archived/Legacy (still in use)
  | 'atom'             // Atom (archived but still used)
  | 'brackets'         // Brackets (archived)
  // Custom option
  | 'custom';

// Comprehensive terminal emulator support
// Based on GitHub stars, Reddit discussions, and developer surveys
export type SupportedTerminal =
  // System Defaults
  | 'system'           // System default terminal
  // macOS Terminals
  | 'terminal'         // Terminal.app (macOS default)
  | 'iterm2'           // iTerm2 (most popular macOS)
  | 'warp'             // Warp (AI-powered, modern)
  | 'ghostty'          // Ghostty (by Mitchell Hashimoto)
  | 'rio'              // Rio (Rust-based, GPU-accelerated)
  // Windows Terminals
  | 'windowsterminal'  // Windows Terminal (Microsoft)
  | 'powershell'       // PowerShell
  | 'cmd'              // Command Prompt
  | 'conemu'           // ConEmu
  | 'cmder'            // Cmder (ConEmu-based)
  | 'gitbash'          // Git Bash
  | 'cygwin'           // Cygwin
  | 'msys2'            // MSYS2
  // Linux Terminals (Desktop Environment defaults)
  | 'gnometerminal'    // GNOME Terminal
  | 'konsole'          // Konsole (KDE)
  | 'xfce4terminal'    // XFCE4 Terminal
  | 'lxterminal'       // LXTerminal
  | 'mate-terminal'    // MATE Terminal
  // Linux Terminals (Feature-rich)
  | 'terminator'       // Terminator (split panes)
  | 'tilix'            // Tilix (tiling terminal)
  | 'guake'            // Guake (dropdown)
  | 'yakuake'          // Yakuake (KDE dropdown)
  | 'tilda'            // Tilda (dropdown)
  // GPU-Accelerated Terminals (Cross-platform)
  | 'alacritty'        // Alacritty (Rust, ~56k GitHub stars)
  | 'kitty'            // Kitty (Python/C, ~25k GitHub stars)
  | 'wezterm'          // WezTerm (Rust, multiplexer built-in)
  // Cross-Platform Terminals
  | 'hyper'            // Hyper (Electron-based)
  | 'tabby'            // Tabby (formerly Terminus)
  | 'extraterm'        // Extraterm (frames-based)
  | 'contour'          // Contour (modern VT)
  // Minimal/Suckless Terminals
  | 'xterm'            // xterm (X11 classic)
  | 'urxvt'            // rxvt-unicode
  | 'st'               // st (suckless terminal)
  | 'foot'             // Foot (Wayland)
  // Specialty/Retro Terminals
  | 'coolretroterm'    // cool-retro-term (CRT aesthetic)
  // Multiplexers (often used as terminal environment)
  | 'tmux'             // tmux (terminal multiplexer)
  | 'zellij'           // Zellij (modern multiplexer)
  // AI-Enhanced
  | 'fig'              // Fig / Amazon Q Developer (autocomplete)
  // Custom option
  | 'custom';

// CLI tools for AI-powered terminal sessions
export type SupportedCLI =
  | 'claude-code'   // Claude Code CLI
  | 'gemini'        // Gemini CLI
  | 'opencode'      // OpenCode
  | 'kilocode'      // Kilo Code CLI
  | 'codex'         // Codex CLI
  | 'custom';

interface ThemePreviewColors {
  bg: string;
  accent: string;
  darkBg: string;
  darkAccent?: string;
}

export interface ColorThemeDefinition {
  id: ColorTheme;
  name: string;
  description: string;
  previewColors: ThemePreviewColors;
}

/** @deprecated removed with the Claude Code refactor (Claude Code takes an effort level instead) */
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';

/** @deprecated removed with the Claude Code refactor (tasks no longer have per-phase models) */
export interface PhaseModelConfig {
  spec: string;
  planning: string;
  coding: string;
  qa: string;
}

/** @deprecated removed with the Claude Code refactor (tasks no longer have per-phase thinking) */
export interface PhaseThinkingConfig {
  spec: ThinkingLevel;
  planning: ThinkingLevel;
  coding: ThinkingLevel;
  qa: ThinkingLevel;
}

/** @deprecated removed with the Claude Code refactor (agent profiles are gone; triage picks the model) */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  icon?: string;
  phaseModels?: PhaseModelConfig;
  phaseThinking?: PhaseThinkingConfig;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  colorTheme?: ColorTheme;
  pythonPath?: string;
  // Node.js (npx starts MCP servers such as Context7); empty = detected
  nodePath?: string;
  gitPath?: string;
  githubCLIPath?: string;
  gitlabCLIPath?: string;
  claudePath?: string;
  autoBuildPath?: string;
  autoUpdateAutoBuild: boolean;
  // Maximum agent terminals per project (MIN_TERMINALS..MAX_TERMINALS_LIMIT)
  maxTerminals?: number;
  notifications: NotificationSettings;
  // Interface font (default Anthropic Sans)
  interfaceFont?: InterfaceFont;
  // Graph page colors (Settings > General > Appearance; default plain)
  graphStyle?: GraphStyle;
  // Shell for agent windows, tasks and tools on Windows (Settings > General; default pwsh, applies after a restart)
  windowsShell?: WindowsShell;
  // Custom tool paths inside WSL, used instead of the paths above while tools run in WSL (Settings > Developer > Paths)
  wslToolPaths?: WslToolPaths;
  // Maximum tasks in progress at once per project; others wait in the Queue (Settings > Claude Code)
  maxParallelTasks?: number;
  // MCP connector defaults for new tasks (Settings > Connectors)
  mcpConnectors?: McpConnectorSettings;
  // How tasks run in Claude Code: triage, planning, validation, budget (Settings > Claude Code)
  claudeCodeTasks?: Partial<ClaudeCodeTaskSettings>;
  // Log order setting for task detail view
  logOrder?: 'chronological' | 'reverse-chronological';
  // Beta updates opt-in (receive pre-release updates)
  betaUpdates?: boolean;
  // Developer tools preferences
  preferredIDE?: SupportedIDE;
  customIDEPath?: string;      // For 'custom' IDE
  preferredTerminal?: SupportedTerminal;
  customTerminalPath?: string; // For 'custom' terminal
  preferredCLI?: SupportedCLI;
  customCLIPath?: string;
  // YOLO mode: invoke Claude with --dangerously-skip-permissions flag
  dangerouslySkipPermissions?: boolean;
  // Sidebar collapsed state (icons only when true)
  sidebarCollapsed?: boolean;
  // GPU acceleration for terminal rendering (WebGL)
  gpuAcceleration?: GpuAcceleration;
  // The open windows (project, place, size, state), reopened on the next launch (kept by the main process)
  windows?: SavedWindowState[];
}

/** A window's place and state, saved when the app quits and restored on the next launch */
export interface WindowState {
  /** Normal bounds (the size the window returns to from maximized or full screen) */
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
  /** The display the window was on */
  displayId?: number;
}

/** One open window as saved for the next launch */
export interface SavedWindowState extends WindowState {
  /** The project it showed (null: none) */
  projectId: string | null;
  /** The window the user worked in last */
  focused?: boolean;
  /** Not opened for a project: it keeps the shared tabs and reopens the project it showed last */
  main?: boolean;
}

// GPU acceleration mode for terminal WebGL rendering
export type GpuAcceleration = 'auto' | 'on' | 'off';


