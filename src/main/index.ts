// Polyfill CommonJS require for ESM compatibility
// This MUST be at the very top, before any imports that load CommonJS native
// modules. Without this, node-pty native module loading fails with
// "ReferenceError: require is not defined".
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// Make require globally available to dependencies that expect it
globalThis.require = require;

// Load .env file FIRST before any other imports that might use process.env
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the project root
// In development: __dirname is out/main (compiled), so go up 2 levels
const possibleEnvPaths = [
  resolve(__dirname, '../../.env'), // Development: out/main -> .env
  resolve(process.cwd(), '.env'),   // Fallback: from the current directory
];

for (const envPath of possibleEnvPaths) {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    break;
  }
}

import { app, BrowserWindow, ipcMain, shell, nativeImage, session, screen, Menu, MenuItem, type Rectangle } from 'electron';
import { join } from 'path';
import { writeFileSync, rmSync, cpSync } from 'fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { setupIpcHandlers } from './ipc-setup';
import { rateLimitResumeScheduler } from './services/rate-limit-resume-scheduler';
import { taskQueue } from './services/task-queue';
import { AgentManager } from './agent';
import { TerminalManager } from './terminal-manager';
import { getUsageMonitor } from './claude-profile/usage-monitor';
import { initializeUsageMonitorForwarding } from './ipc-handlers/terminal-handlers';
import { initializeAppUpdater, stopPeriodicUpdates } from './app-updater';
import { DEFAULT_APP_SETTINGS, IPC_CHANNELS, TITLE_BAR_OVERLAY_HEIGHT, SPELL_CHECK_LANGUAGE_MAP, DEFAULT_SPELL_CHECK_LANGUAGE, ADD_TO_DICTIONARY_LABELS, WINDOW_PROJECT_ARG } from '../shared/constants';
import { getAppLanguage, initAppLanguage } from './app-language';
import { readSettingsFile } from './settings-utils';
import { liveAgentRelay } from './live-agent/live-agent-relay';
import { stopMcpProbes } from './mcp-availability';
import { browserDrawer } from './browser-drawer';
import { watchBrowserDisplayScale } from './browser-drawer/display-scale';
import { syncLiveAgentAtStartup } from './live-agent/live-agent-projects';
import { appLog, setupErrorLogging } from './app-logger';
import { preWarmToolCache, warmToolInfo } from './cli-tool-manager';
import { initializeClaudeProfileManager, getClaudeProfileManager } from './claude-profile-manager';
import { isProfileAuthenticated, getPlanFromConfigDir } from './claude-profile/profile-utils';
import { isLinux, isMacOS, isWindows, isWSL } from './platform';
import { initShellRuntime } from './platform/shell-runtime';
import { detectBrowserProfiles } from './browser-profiles/detect';
import { removeLeftoverBrowserProfileCopies, removeLiveBrowserProfileCopies } from './browser-profiles/profile-copy';
import { removeLeftoverTempFolders, TEMP_FOLDER_PREFIXES } from './temp-folders';
import { scanChatBrowserLeftovers } from './browser-drawer/chat-browser-restore';
import { checkRuntimeAtStartup } from './worktree/runtime-switch';
import { ensureDevDesktopEntry } from './dev-desktop-entry';
import { ptyDaemonClient } from './terminal/pty-daemon-client';
import { AppTray, isWindowCloseAllowed, type TrayStatus } from './app-tray';
import {
  applyRestoredWindowState,
  loadMainWindowState,
  loadRestoredWindows,
  saveWindowStateOnQuit,
  trackWindowState,
  type RestoredWindow
} from './window-state';
import { writeClaudeThemeSettings } from './claude-cli-theme';
import {
  focusWindowById,
  getAllWindows,
  getFocusedWindow,
  getWindowCount,
  isClosingForReal,
  listProjectWindows,
  onProjectWindowsChanged,
  registerWindow,
  showWindow
} from './window-manager';
import { notifyProjectWindowsChanged } from './ipc-handlers/window-handlers';
import { safeSendToRenderer, setRendererWindowsProvider } from './ipc-handlers/utils';
import type { AppSettings, AuthFailureInfo } from '../shared/types';
import { projectStore } from './project-store';
import { migrateProjectDataDirs } from './data-dir-migration';

// ─────────────────────────────────────────────────────────────────────────────
// Single instance: launching the installed app again (Start menu, taskbar, shortcut) shows the
// running one instead of starting a second app with its own tray icon. Development builds skip
// the lock, since they share userData (which the lock is keyed on) with the installed app.
// ─────────────────────────────────────────────────────────────────────────────
const hasInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrate userData from the previous app name (aperant)
// Must run before any code accesses app.getPath('userData')
// ─────────────────────────────────────────────────────────────────────────────
{
  const newUserData = app.getPath('userData');
  const oldUserData = ['aperant']
    .map((name) => join(dirname(newUserData), name))
    .find((dir) => existsSync(dir));
  if (oldUserData && !existsSync(join(newUserData, '.migrated'))) {
    try {
      cpSync(oldUserData, newUserData, { recursive: true, force: false, errorOnExist: false });
      writeFileSync(join(newUserData, '.migrated'), new Date().toISOString());
      console.warn(`[main] Migrated userData from ${oldUserData} to ${newUserData}`);
    } catch (err) {
      console.warn('[main] userData migration failed (non-fatal):', err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Window sizing constants
// ─────────────────────────────────────────────────────────────────────────────
/** Preferred window width on startup */
const WINDOW_PREFERRED_WIDTH: number = 1400;
/** Preferred window height on startup */
const WINDOW_PREFERRED_HEIGHT: number = 900;
/** Absolute minimum window width (supports high DPI displays with scaling) */
const WINDOW_MIN_WIDTH: number = 800;
/** Absolute minimum window height (supports high DPI displays with scaling) */
const WINDOW_MIN_HEIGHT: number = 500;
/** Margin from screen edges to avoid edge-to-edge windows */
const WINDOW_SCREEN_MARGIN: number = 20;
/** Default screen dimensions used as fallback when screen.getPrimaryDisplay() fails */
const DEFAULT_SCREEN_WIDTH: number = 1920;
const DEFAULT_SCREEN_HEIGHT: number = 1080;

// Setup error logging early (captures uncaught exceptions)
setupErrorLogging();

/**
 * Load app settings synchronously (for use during startup).
 * This is a simple merge with defaults - no migrations or auto-detection.
 */
function loadSettingsSync(): AppSettings {
  const savedSettings = readSettingsFile();
  return { ...DEFAULT_APP_SETTINGS, ...savedSettings } as AppSettings;
}

/**
 * Clean up stale update metadata files from the redundant source updater system.
 *
 * The old "source updater" wrote .update-metadata.json files that could persist
 * across app updates and cause version display desync. This cleanup ensures
 * we use the actual bundled version from app.getVersion().
 */
function cleanupStaleUpdateMetadata(): void {
  const userData = app.getPath('userData');
  const stalePaths = [
    join(userData, 'backend-source'),
  ];

  for (const stalePath of stalePaths) {
    if (existsSync(stalePath)) {
      try {
        rmSync(stalePath, { recursive: true, force: true });
        console.warn(`[main] Cleaned up stale update metadata: ${stalePath}`);
      } catch (e) {
        console.warn(`[main] Failed to clean up stale metadata at ${stalePath}:`, e);
      }
    }
  }
}

// Get icon path based on platform
function getIconPath(): string {
  // In dev mode, __dirname is out/main, so we go up to project root then into resources
  // In production, resources are in the app's resources folder
  const resourcesPath = is.dev
    ? join(__dirname, '../../resources')
    : join(process.resourcesPath);

  let iconName: string;
  if (isMacOS()) {
    // Use PNG in dev mode (works better), ICNS in production
    iconName = is.dev ? 'icon-256.png' : 'icon.icns';
  } else if (isWindows()) {
    iconName = 'icon.ico';
  } else {
    iconName = 'icon.png';
  }

  const iconPath = join(resourcesPath, iconName);
  return iconPath;
}

// System tray (background mode); while it exists, closing the last window only hides it
let appTray: AppTray | null = null;

/** Bring a window back from the tray (recreating one if every window was closed) */
function showMainWindow(): void {
  const window = getFocusedWindow();
  if (!window) {
    createWindow(null, loadMainWindowState());
    return;
  }
  showWindow(window);
}
let agentManager: AgentManager | null = null;
let terminalManager: TerminalManager | null = null;

// Capture child process exits (renderer/GPU/utility) for crash diagnostics.
app.on('child-process-gone', (_event, details) => {
  appLog.error('[main] child-process-gone:', details);
});

// Re-entrancy guard for before-quit handler.
// The first before-quit call pauses quit for async cleanup, then calls app.quit() again.
// The second call sees isQuitting=true and allows quit to proceed immediately.
// Fixes: pty.node SIGABRT crash caused by environment teardown before PTY cleanup (GitHub #1469)
let isQuitting = false;

// Renderer recovery budget (prevents infinite reload loops on persistent failures).
// The budget is per window, so one window's crashes don't stop another's recovery.
const MAX_RENDERER_RECOVERY_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const RENDERER_RECOVERY_DELAY_MS = 500;

interface RendererRecoveryState {
  attempts: number;
  windowStart: number;
}

function scheduleRendererRecovery(window: BrowserWindow, state: RendererRecoveryState, trigger: string): void {
  if (window.isDestroyed() || isQuitting) {
    return;
  }

  const now = Date.now();
  if (state.windowStart === 0 || now - state.windowStart > RENDERER_RECOVERY_WINDOW_MS) {
    state.windowStart = now;
    state.attempts = 0;
  }

  if (state.attempts >= MAX_RENDERER_RECOVERY_ATTEMPTS) {
    appLog.error(
      `[main] Renderer recovery budget exhausted after trigger: ${trigger} (${state.attempts}/${MAX_RENDERER_RECOVERY_ATTEMPTS})`
    );
    return;
  }

  state.attempts++;
  appLog.error(
    `[main] Renderer failure detected (${trigger}). Attempting recovery ${state.attempts}/${MAX_RENDERER_RECOVERY_ATTEMPTS}`
  );

  setTimeout(() => {
    if (window.isDestroyed() || isQuitting) {
      return;
    }
    window.webContents.reload();
    if (!window.isVisible()) {
      window.show();
    }
  }, RENDERER_RECOVERY_DELAY_MS);
}

/** Run `done` once the window stops moving and resizing (window managers apply a size in steps) */
function whenBoundsSettle(window: BrowserWindow, done: () => void): void {
  let timer: NodeJS.Timeout | undefined;
  const wait = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      window.off('resize', wait);
      window.off('move', wait);
      if (!window.isDestroyed()) done();
    }, 200);
  };
  window.on('resize', wait);
  window.on('move', wait);
  wait();
}

/**
 * WSL's window manager (WSLg) shows a maximized frameless window as if it still had its frame
 * (shadow and title bar), so it hangs off the right and bottom of the screen and the close button
 * is out of reach. There, a maximized window is turned into a normal window of the same size and
 * place, and maximizing again (the button or a double click on the title bar) brings back the
 * earlier size.
 */
function fillScreenOnMaximize(window: BrowserWindow): void {
  // The earlier size, and the size the window was given in its place, while it fills the screen
  let filled: { restore: Rectangle; fill: Rectangle } | null = null;

  // The window manager applies maximize, restore and resize in steps (and resizing while the
  // window still counts as maximized fires 'maximize' again), so each step waits for the window
  // to settle, and events are ignored until the switch is done
  let switching = false;
  window.on('maximize', () => {
    if (switching) return;
    switching = true;
    const restore = filled ? filled.restore : window.getNormalBounds();
    whenBoundsSettle(window, () => {
      // The maximized size leaves out the Windows taskbar, which Electron's work area under
      // WSL doesn't know about
      const target = filled ? restore : window.getBounds();
      filled = filled ? null : { restore, fill: target };
      window.unmaximize();
      whenBoundsSettle(window, () => {
        window.setBounds(target);
        whenBoundsSettle(window, () => {
          switching = false;
        });
      });
    });
  });

  // Moving or resizing the filled window by hand makes that its new size
  const forgetFilled = (): void => {
    if (switching || !filled) return;
    const bounds = window.getBounds();
    const { fill } = filled;
    if (bounds.x !== fill.x || bounds.y !== fill.y || bounds.width !== fill.width || bounds.height !== fill.height) {
      filled = null;
    }
  };
  window.on('move', forgetFilled);
  window.on('resize', forgetFilled);
}

/** Look at what an earlier run left behind (see the call at startup); best effort, one folder at a time */
async function removeCrashLeftovers(): Promise<void> {
  const projects = projectStore.getProjects();
  try {
    const restorable = await scanChatBrowserLeftovers({ projects: projects.map((project) => ({ id: project.id, path: project.path })) });
    for (const browser of restorable) browserDrawer.chatBrowsers.addRestorable(browser);
  } catch (error) {
    appLog.warn('[Startup] Could not look at the chat browsers left by an earlier run:', error);
  }
  await removeLeftoverTempFolders({ skip: [TEMP_FOLDER_PREFIXES.chatBrowser] }).catch((error: unknown) => {
    appLog.warn('[Startup] Could not remove the temp folders left by an earlier run:', error);
  });
  await removeLeftoverBrowserProfileCopies(projects.map((project) => project.path));
}

/**
 * Create an app window. `assignedProjectId` is the project the window opens (the Projects
 * page's "New window", or a window reopened at launch); null restores the project shown last.
 * `restored` is a saved window's place and state (windows reopened at launch).
 */
function createWindow(assignedProjectId: string | null = null, restored: RestoredWindow | null = null): BrowserWindow {
  // Get the primary display's work area (accounts for taskbar, dock, etc.)
  // Wrapped in try/catch to handle potential failures with fallback to safe defaults
  let workAreaSize: { width: number; height: number };
  try {
    const display = screen.getPrimaryDisplay();
    // Validate the returned object has expected structure with valid dimensions
    if (
      display?.workAreaSize &&
      typeof display.workAreaSize.width === 'number' &&
      typeof display.workAreaSize.height === 'number' &&
      display.workAreaSize.width > 0 &&
      display.workAreaSize.height > 0
    ) {
      workAreaSize = display.workAreaSize;
    } else {
      console.error(
        '[main] screen.getPrimaryDisplay() returned unexpected structure:',
        JSON.stringify(display)
      );
      workAreaSize = { width: DEFAULT_SCREEN_WIDTH, height: DEFAULT_SCREEN_HEIGHT };
    }
  } catch (error: unknown) {
    console.error('[main] Failed to get primary display, using fallback dimensions:', error);
    workAreaSize = { width: DEFAULT_SCREEN_WIDTH, height: DEFAULT_SCREEN_HEIGHT };
  }

  // Calculate available space with a small margin to avoid edge-to-edge windows
  const availableWidth: number = workAreaSize.width - WINDOW_SCREEN_MARGIN;
  const availableHeight: number = workAreaSize.height - WINDOW_SCREEN_MARGIN;

  // Calculate actual dimensions (preferred, but capped to margin-adjusted available space)
  const width: number = Math.min(WINDOW_PREFERRED_WIDTH, availableWidth);
  const height: number = Math.min(WINDOW_PREFERRED_HEIGHT, availableHeight);

  // A reopened window goes where it was (display and size); without it, centred on the primary display
  const bounds = restored?.bounds ?? { width, height };

  // Ensure minimum dimensions don't exceed the actual initial window size
  const minWidth: number = Math.min(WINDOW_MIN_WIDTH, bounds.width);
  const minHeight: number = Math.min(WINDOW_MIN_HEIGHT, bounds.height);

  // Create the browser window
  const appWindow = new BrowserWindow({
    ...bounds,
    minWidth,
    minHeight,
    show: false,
    autoHideMenuBar: true,
    // No OS title bar: macOS keeps its inset traffic lights; Windows/Linux get Electron-drawn
    // window controls over the top-right corner, recolored by the renderer to match the theme
    ...(isMacOS()
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 15, y: 10 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#151515', symbolColor: '#F0EFEC', height: TITLE_BAR_OVERLAY_HEIGHT }
        }),
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // Prevent terminal lag when window loses focus
      spellcheck: true, // Enable spell check for text inputs
      // The renderer reads the project to open from here, so it never flashes another one
      additionalArguments: assignedProjectId ? [`${WINDOW_PROJECT_ARG}${assignedProjectId}`] : []
    }
  });

  registerWindow(appWindow, assignedProjectId);
  // Before the close handler below, so a window hiding to the tray is saved while still visible
  trackWindowState(appWindow, restored, assignedProjectId === null);
  if (isWSL()) {
    fillScreenOnMaximize(appWindow);
  }
  const recovery: RendererRecoveryState = { attempts: 0, windowStart: 0 };

  // Background mode: closing a window hides it to the tray; agents and terminals keep running
  // and its project stays open, so the tray still lists it and selecting it brings the window
  // back. Only "Quit window" on a project card closes a window for real, and real quits (tray
  // "Quit", OS quit) set isQuitting first and close normally.
  appWindow.on('close', (event) => {
    const hideToTray =
      !isQuitting &&
      appTray !== null &&
      !isWindowCloseAllowed() &&
      !isClosingForReal(appWindow.id);
    if (hideToTray) {
      event.preventDefault();
      appWindow.hide();
    }
  });
  appWindow.on('show', () => appTray?.refresh());
  appWindow.on('hide', () => appTray?.refresh());

  // Show window when ready to avoid visual flash
  appWindow.on('ready-to-show', () => {
    // Reopened windows other than the one used last stay behind it
    if (restored && !restored.focused) appWindow.showInactive();
    else appWindow.show();
    // Maximized / full screen only once shown (Linux ignores it earlier), on the restored display
    if (restored) applyRestoredWindowState(appWindow, restored);
  });

  // Capture renderer process crashes/termination reasons for diagnostics.
  appWindow.webContents.on('render-process-gone', (_event, details) => {
    appLog.error('[main] render-process-gone:', details);
    if (details.reason !== 'clean-exit') {
      scheduleRendererRecovery(appWindow, recovery, `render-process-gone:${details.reason}`);
    }
  });

  // Recover main-frame load failures (excluding intentional aborted loads, ERR_ABORTED = -3)
  appWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }
    appLog.error(`[main] Main frame failed to load (${errorCode}): ${errorDescription} (${validatedURL})`);
    scheduleRendererRecovery(appWindow, recovery, `did-fail-load:${errorCode}`);
  });

  // The attempt budget is only reset by its 60s window (not here), so a renderer that
  // crashes right after every load cannot reload forever
  appWindow.webContents.on('did-finish-load', () => {
    if (recovery.attempts > 0) {
      appLog.warn(`[main] Renderer reloaded after ${recovery.attempts} recovery attempt(s)`);
    }
  });

  // Configure initial spell check languages with proper fallback logic
  // Uses shared constant for consistency with the IPC handler
  const defaultLanguage = 'en';
  const defaultSpellCheckLanguages = SPELL_CHECK_LANGUAGE_MAP[defaultLanguage] || [DEFAULT_SPELL_CHECK_LANGUAGE];
  const availableSpellCheckLanguages = session.defaultSession.availableSpellCheckerLanguages;
  const validSpellCheckLanguages = defaultSpellCheckLanguages.filter(lang =>
    availableSpellCheckLanguages.includes(lang)
  );
  const initialSpellCheckLanguages = validSpellCheckLanguages.length > 0
    ? validSpellCheckLanguages
    : (availableSpellCheckLanguages.includes(DEFAULT_SPELL_CHECK_LANGUAGE) ? [DEFAULT_SPELL_CHECK_LANGUAGE] : []);

  if (initialSpellCheckLanguages.length > 0) {
    session.defaultSession.setSpellCheckerLanguages(initialSpellCheckLanguages);
    console.log(`[SPELLCHECK] Initial languages set to: ${initialSpellCheckLanguages.join(', ')}`);
  } else {
    console.warn('[SPELLCHECK] No spell check languages available on this system');
  }

  // Handle context menu with spell check and standard editing options
  appWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    // Add spelling suggestions if there's a misspelled word
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => appWindow.webContents.replaceMisspelling(suggestion)
        }));
      }

      if (params.dictionarySuggestions.length > 0) {
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // Use localized label for "Add to Dictionary" based on app language (not OS locale)
      // getAppLanguage() tracks the user's in-app language setting, updated via SPELLCHECK_SET_LANGUAGES IPC
      const addToDictionaryLabel = ADD_TO_DICTIONARY_LABELS[getAppLanguage()] || ADD_TO_DICTIONARY_LABELS['en'];
      menu.append(new MenuItem({
        label: addToDictionaryLabel,
        click: () => appWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Standard editing options for editable fields
    // Using role without explicit label allows Electron to provide localized labels
    if (params.isEditable) {
      menu.append(new MenuItem({
        role: 'cut',
        enabled: params.editFlags.canCut
      }));
      menu.append(new MenuItem({
        role: 'copy',
        enabled: params.editFlags.canCopy
      }));
      menu.append(new MenuItem({
        role: 'paste',
        enabled: params.editFlags.canPaste
      }));
      menu.append(new MenuItem({
        role: 'selectAll',
        enabled: params.editFlags.canSelectAll
      }));
    } else if (params.selectionText?.trim()) {
      // Non-editable text selection (e.g., labels, paragraphs)
      // Use .trim() to avoid showing menu for whitespace-only selections
      menu.append(new MenuItem({
        role: 'copy',
        enabled: params.editFlags.canCopy
      }));
    }

    // Only show menu if there are items
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Handle external links with URL scheme allowlist for security
  // Note: Terminal links now use IPC via WebLinksAddon callback, but this handler
  // catches any other window.open() calls (e.g., from third-party libraries)
  const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:'];
  appWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url);
      if (!ALLOWED_URL_SCHEMES.includes(url.protocol)) {
        console.warn('[main] Blocked URL with disallowed scheme:', details.url);
        return { action: 'deny' };
      }
    } catch {
      console.warn('[main] Blocked invalid URL:', details.url);
      return { action: 'deny' };
    }
    shell.openExternal(details.url).catch((error) => {
      console.warn('[main] Failed to open external URL:', details.url, error);
    });
    return { action: 'deny' };
  });

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    appWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    appWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Open DevTools in development, for the first window only
  if (is.dev && getWindowCount() === 1) {
    appWindow.webContents.openDevTools({ mode: 'right' });
  }

  return appWindow;
}

/**
 * Plan and usage for the tray menu, which are only shown while a Claude account is signed
 * in. Reading them parses the account's settings file, and the menu is now rebuilt whenever
 * a window opens, closes or switches project, so the answer is held briefly: the periodic
 * refresh and usage updates keep it current.
 */
const TRAY_STATUS_TTL_MS = 5_000;
let trayStatus: { value: TrayStatus; readAt: number } | null = null;

function readTrayStatus(): TrayStatus {
  if (trayStatus && Date.now() - trayStatus.readAt < TRAY_STATUS_TTL_MS) return trayStatus.value;
  let value: TrayStatus = { planName: null, sessionPercent: null };
  try {
    const profile = getClaudeProfileManager().getActiveProfile();
    if (profile && isProfileAuthenticated(profile)) {
      value = {
        planName: getPlanFromConfigDir(profile.configDir),
        sessionPercent: getUsageMonitor().getCurrentUsage()?.sessionPercent ?? null
      };
    }
  } catch {
    // Profile manager not ready yet
  }
  trayStatus = { value, readAt: Date.now() };
  return value;
}

// Set app name before ready (for dock tooltip on macOS in dev mode). Development builds get their
// own name, which also gives their window its own class, so taskbars don't group them with (and
// show the icon of) the installed app. userData was resolved above, so both still share it.
const APP_NAME = is.dev ? 'Workbench Dev' : 'Workbench';
app.setName(APP_NAME);
if (isMacOS()) {
  // Force the name to appear in dock on macOS
  app.name = APP_NAME;
}

// Fix Windows GPU cache permission errors (0x5 Access Denied)
if (isWindows()) {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
  console.log('[main] Applied Windows GPU cache fixes');
}

// WSL's graphics (WSLg) lose Chromium's GPU process shortly after startup, and the window then
// stops repainting (it keeps its first frame while the page goes on). Draw in software there.
if (isWSL()) {
  app.disableHardwareAcceleration();
}

// Initialize the application
app.whenReady().then(async () => {
  // A second instance is exiting; it hands its launch to the running app ('second-instance')
  if (!hasInstanceLock) return;

  // Set app user model id for Windows
  electronApp.setAppUserModelId(is.dev ? 'com.workbench.app.dev' : 'com.workbench.app');

  // Decide where tools run on Windows (native, or WSL with the windowsShell setting) before the
  // tool cache and Claude accounts are read; detection runs in the background, windows don't wait
  void initShellRuntime(readSettingsFile()?.windowsShell);
  // Browser profiles for the Playwright connector, looked for once (after the shell runtime is known)
  void detectBrowserProfiles();
  // The browser drawer: Playwright's headless browsers (task runs, chats), watched for every window
  void browserDrawer.start();
  // Its browsers render at the screens' pixel density, so the drawer shows them sharp
  watchBrowserDisplayScale();

  // Linux shells take the dock/taskbar icon from a desktop entry matching the window class; give the
  // development build ("Workbench Dev") its own one, or it shows a generic icon
  if (is.dev && isLinux()) {
    void ensureDevDesktopEntry(APP_NAME, resolve(getIconPath()), resolve(__dirname, '../..'));
  }

  // Clear cache on Windows to prevent permission errors from stale cache
  if (isWindows()) {
    session.defaultSession.clearCache()
      .then(() => console.log('[main] Cleared cache on startup'))
      .catch((err) => console.warn('[main] Failed to clear cache:', err));
  }

  // Initialize app language from OS locale for main process i18n (context menus)
  initAppLanguage();

  // Clean up stale update metadata from the old source updater system
  // This prevents version display desync after electron-updater installs a new version
  cleanupStaleUpdateMetadata();

  // Set dock icon on macOS
  if (isMacOS()) {
    const iconPath = getIconPath();
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        app.dock?.setIcon(icon);
      }
    } catch (e) {
      console.warn('Could not set dock icon:', e);
    }
  }

  // Settings files that give a Claude Code session the app's own light/dark theme
  writeClaudeThemeSettings();

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Move projects' data folders to their current names (specs -> tasks, memory -> knowledge,
  // insights -> chats) before anything reads tasks
  await Promise.all(
    projectStore.getProjects().map((project) => migrateProjectDataDirs(project.path, project.autoBuildPath))
  );
  // Leftovers of a crash, a kill or a quit during a run (in the background): chat browsers are kept
  // for their chats to open again (their profile copies too), then the temp folders and browser
  // profile copies (they hold cookies) no running Workbench or run uses are removed
  void removeCrashLeftovers();

  // Initialize agent manager
  agentManager = new AgentManager();


  // Initialize terminal manager
  terminalManager = new TerminalManager(() => getFocusedWindow());

  // Events go to every project window; dialogs and lookups use the window in use
  setRendererWindowsProvider(() => getAllWindows());

  // Setup IPC handlers
  setupIpcHandlers(agentManager, terminalManager, () => getFocusedWindow(), {
    createProjectWindow: (projectId: string) => createWindow(projectId)
  });

  // Live agent: refresh the setup of projects that have it on and start their relay (until the app quits)
  void syncLiveAgentAtStartup().catch((error) => appLog.error('[LiveAgent] Startup failed:', error));

  // Re-arm resume timers for tasks held by a rate limit (holds survive restarts;
  // holds whose reset time already passed resume shortly after startup)
  setImmediate(() => {
    const scheduled = rateLimitResumeScheduler.scanAndScheduleAll();
    if (scheduled > 0) {
      console.warn(`[main] Scheduled ${scheduled} rate-limit-held task(s) for resume`);
    }
    // Start queued tasks that fit the parallel task limit (e.g. queued before a restart)
    taskQueue.request();
  });

  // Reopen the windows open when the app quit, each with its project, place and state (the
  // main one restores the project it showed last; the one used last is created last, so it
  // ends up on top); else one window that restores the project it showed last
  const restoredWindows = loadRestoredWindows((projectId) => projectStore.getProject(projectId) !== undefined);
  const createdWindows = restoredWindows.map((restored) => createWindow(restored.projectId, restored));
  const firstWindow = createdWindows[0] ?? createWindow();

  // Tray icon for background mode (a desktop without a tray just keeps the old close-to-quit behavior)
  try {
    // WSL has no tray to show the icon in (WSLg forwards only windows), yet creating one doesn't
    // fail, so a closed window would hide to a tray icon nobody can see
    if (isWSL()) throw new Error('WSL has no system tray');
    appTray = new AppTray({
      iconsDir: is.dev ? join(__dirname, '../../resources/tray') : join(process.resourcesPath, 'tray'),
      devBuild: is.dev,
      onShowApp: showMainWindow,
      onFocusWindow: focusWindowById,
      onQuit: () => app.quit(),
      // With more than one window open, the menu lists them by project instead of "Show App"
      getWindows: () =>
        listProjectWindows().map(({ windowId, projectId }) => ({
          windowId,
          projectName: projectId ? projectStore.getProject(projectId)?.name ?? null : null
        })),
      getStatus: readTrayStatus
    });
    // New usage means the held status is stale
    getUsageMonitor().on('usage-updated', () => {
      trayStatus = null;
      appTray?.refresh();
    });
  } catch (error) {
    appLog.warn('[main] System tray unavailable, closing the window will quit the app:', error);
    appTray = null;
  }

  // A window opening, closing or switching project changes the tray's window list and the
  // project cards' "Quit window" (also without a tray)
  onProjectWindowsChanged(() => {
    appTray?.refresh();
    notifyProjectWindowsChanged();
  });

  // Recolor the Windows/Linux window controls to match the active theme
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  ipcMain.on(IPC_CHANNELS.WINDOW_SET_TITLE_BAR_COLORS, (event, colors: { color?: unknown; symbolColor?: unknown }) => {
    if (isMacOS()) return;
    const { color, symbolColor } = colors ?? {};
    if (typeof color !== 'string' || typeof symbolColor !== 'string' || !HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return;
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT });
  });


  // Pre-warm CLI tool cache in background (non-blocking)
  // This ensures CLI detection is done before user needs it
  // Include all commonly used tools to prevent sync blocking on first use
  setImmediate(() => {
    preWarmToolCache(['claude', 'git', 'gh', 'python']).catch((error) => {
      console.warn('[main] Failed to pre-warm CLI cache:', error);
    });
    // Detection details for Settings > Developer > Paths, so the page opens instantly
    warmToolInfo();
    // Windows: worktrees repaired when tools run in another runtime (native / WSL) than last time
    void checkRuntimeAtStartup();
  });

  // Initialize Claude profile manager, then start usage monitor
  // We do this sequentially to ensure profile data
  // is loaded BEFORE the usage monitor attempts to read it.
  // This prevents the "UsageMonitor disabled" error due to race condition.
  // Forwarding is registered once, here: the monitor's events go to every window either way
  initializeUsageMonitorForwarding(() => getFocusedWindow());

  initializeClaudeProfileManager()
    .then(() => {
      // Quitting during profile load already stopped the monitor; starting it now would
      // re-arm its timers while the app tears down
      if (isQuitting) return;

      // Start the usage monitor (uses unified OperationRegistry for proactive restart)
      const usageMonitor = getUsageMonitor();
      usageMonitor.start();
      console.warn('[main] Usage monitor initialized and started (after profile load)');

      // Check for migrated profiles that need re-authentication
      // These profiles were moved from shared ~/.claude to isolated directories
      // and need new credentials since they now use a different keychain entry
      const profileManager = getClaudeProfileManager();
      const migratedProfileIds = profileManager.getMigratedProfileIds();
      const activeProfile = profileManager.getActiveProfile();

      if (migratedProfileIds.length > 0) {
        console.warn('[main] Found migrated profiles that need re-authentication:', migratedProfileIds);

        // Check ALL migrated profiles for valid credentials, not just the active one
        // This prevents stale migrated flags from triggering unnecessary re-auth prompts
        // when the user switches to a different profile later
        for (const profileId of migratedProfileIds) {
          const profile = profileManager.getProfile(profileId);
          if (profile && isProfileAuthenticated(profile)) {
            // Credentials are valid - clear the migrated flag
            console.warn('[main] Migrated profile has valid credentials via file fallback, clearing migrated flag:', profile.name);
            profileManager.clearMigratedProfile(profileId);
          }
        }

        // Re-check if the active profile still needs re-auth after clearing valid ones
        const remainingMigratedIds = profileManager.getMigratedProfileIds();
        if (remainingMigratedIds.includes(activeProfile.id)) {
          // Active profile still needs re-auth - show the modal
          firstWindow.webContents.once('did-finish-load', () => {
            // Small delay to ensure stores are initialized
            setTimeout(() => {
              if (firstWindow.isDestroyed()) return;
              const authFailureInfo: AuthFailureInfo = {
                profileId: activeProfile.id,
                profileName: activeProfile.name,
                failureType: 'missing',
                message: `Profile "${activeProfile.name}" was migrated to an isolated directory and needs re-authentication.`,
                detectedAt: new Date()
              };
              console.warn('[main] Sending auth failure for migrated active profile:', activeProfile.name);
              // Whichever windows are open get it, not just the one the app started with
              safeSendToRenderer(getFocusedWindow, IPC_CHANNELS.CLAUDE_AUTH_FAILURE, authFailureInfo);
            }, 1000);
          });
        }
      }
    })
    .catch((error) => {
      console.warn('[main] Failed to initialize profile manager:', error);
      // Fallback: try starting usage monitor anyway (might use defaults)
      if (!isQuitting) getUsageMonitor().start();
    });

  // Log debug mode status
  const isDebugMode = process.env.DEBUG === 'true';
  if (isDebugMode) {
    console.warn('[main] ========================================');
    console.warn('[main] DEBUG MODE ENABLED (DEBUG=true)');
    console.warn('[main] ========================================');
  }

  // Initialize the app auto-updater. It checks once at launch and notifies about a new version.
  // Development builds get it too, so a lowered package.json version can try the update flow;
  // they don't check periodically (unless DEBUG_UPDATER=true) and never download or install
  // (see app-updater.ts)
  {
    // Load settings to get beta updates preference
    const settings = loadSettingsSync();
    const betaUpdates = settings.betaUpdates ?? false;

    initializeAppUpdater(() => getFocusedWindow(), betaUpdates);
    console.warn('[main] App auto-updater initialized');
    console.warn(`[main] Beta updates: ${betaUpdates ? 'enabled' : 'disabled'}`);
  }

  // macOS: clicking the dock icon re-creates the window, or shows it if it was hidden to the tray
  app.on('activate', () => {
    showMainWindow();
  });

  // Windows/Linux: launching the app while it runs shows its window, or brings one back from the tray
  app.on('second-instance', () => {
    showMainWindow();
  });
});

// Quit when all windows are closed (except on macOS, or while the tray keeps the app in
// the background: "Show App" then opens a window again)
app.on('window-all-closed', () => {
  if (!isMacOS() && !appTray) {
    app.quit();
  }
});

// Cleanup before quit — uses event.preventDefault() to allow async PTY cleanup
// before the JS environment tears down. Without this, pty.node's native
// ThreadSafeFunction callbacks fire after teardown, causing SIGABRT (GitHub #1469).
app.on('before-quit', (event) => {
  // Re-entrancy guard: the second app.quit() call (after cleanup) must pass through
  if (isQuitting) {
    return;
  }
  isQuitting = true;

  // Pause quit to perform async cleanup
  event.preventDefault();

  // Remember every open window while they are still open (reopened on the next launch)
  saveWindowStateOnQuit();

  // Stop synchronous services immediately
  stopPeriodicUpdates();
  rateLimitResumeScheduler.dispose();
  taskQueue.dispose();
  stopMcpProbes();

  const usageMonitor = getUsageMonitor();
  usageMonitor.stop();
  console.warn('[main] Usage monitor stopped');

  appTray?.destroy();
  appTray = null;

  // Perform async cleanup, then allow quit to proceed
  (async () => {
    try {
      // Stop the Live agent relay worker (removes its discovery files, closes its hook server)
      await liveAgentRelay.shutdown();

      // Stop the browser drawer's bridge (it disconnects; the browsers stop with their runs)
      await browserDrawer.shutdown();

      // Kill all running agent processes
      if (agentManager) {
        await agentManager.killAll();
      }

      // Kill all terminal processes — waits for PTY exit with bounded timeout
      if (terminalManager) {
        await terminalManager.killAll();
      }

      // Browser profile copies of runs still going (chat turns aren't stopped by quitting)
      await removeLiveBrowserProfileCopies();

      // Shut down PTY daemon client AFTER terminal cleanup completes,
      // ensuring all kill commands reach PTY processes before the daemon disconnects
      ptyDaemonClient.shutdown();
      console.warn('[main] PTY daemon client shutdown complete');
    } catch (error) {
      console.error('[main] Error during pre-quit cleanup:', error);
    } finally {
      // Always allow quit to proceed, even if cleanup fails
      app.quit();
    }
  })();
});

// Safety net: no Live agent relay worker outlives the app (before-quit normally stopped it)
app.on('will-quit', () => {
  liveAgentRelay.terminateNow();
  browserDrawer.killNow();
});

// Note: Uncaught exceptions and unhandled rejections are now
// logged by setupErrorLogging() in app-logger.ts
