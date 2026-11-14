/**
 * Background mode: system tray icon with a small menu.
 *
 * While the tray exists, closing a window asks whether to keep running in the background, which
 * hides it (agents and terminals keep running, and the window stays listed below), or to quit; "Quit" in the tray menu (or quitting from the OS) exits
 * the app. The menu shows the active Claude plan and the current 5-hour session usage when
 * they're known.
 *
 * With more than one project window open, "Show App" is replaced by one entry per window,
 * labelled with the project it shows, which focuses that window.
 */

import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'path';
import { TRAY_MENU_LABELS, type TrayMenuLabels } from '../shared/constants';
import { isMacOS } from './platform';
import { getAppLanguage } from './app-language';

// Set right before an update install: the updater may close windows before the app's
// 'before-quit' fires (Squirrel.Mac), so hide-to-tray must step aside
let windowCloseAllowed = false;

/** Let the main window close for real (used before quitting to install an update) */
export function allowWindowClose(): void {
  windowCloseAllowed = true;
}

export function isWindowCloseAllowed(): boolean {
  return windowCloseAllowed;
}

export interface TrayStatus {
  /** Plan of the signed-in Claude account, e.g. "max" or "pro" (null when unknown or signed out) */
  planName: string | null;
  /** 5-hour session usage in percent (null when unknown or signed out) */
  sessionPercent: number | null;
}

/** An open project window, as the tray menu lists it */
export interface TrayProjectWindow {
  windowId: number;
  /** Name of the project the window shows (null while it shows none) */
  projectName: string | null;
}

export interface AppTrayOptions {
  /** Directory holding tray-icon.png / trayTemplate.png (and their @2x variants) */
  iconsDir: string;
  /** Use the development build's hammer icons (tray-icon-dev.png / trayTemplate-dev.png) */
  devBuild?: boolean;
  onShowApp: () => void;
  /** Focus one of the open project windows (menu entries, only with more than one window) */
  onFocusWindow: (windowId: number) => void;
  onQuit: () => void;
  getStatus: () => TrayStatus;
  /** The open project windows, newest last (empty or single: the menu keeps "Show App") */
  getWindows: () => TrayProjectWindow[];
}

function labels(): TrayMenuLabels {
  return TRAY_MENU_LABELS[getAppLanguage()] ?? TRAY_MENU_LABELS.en;
}

/** "max" → "Max plan" */
export function formatPlanLabel(planName: string, template = labels().plan): string {
  const plan = planName.trim();
  return template.replace('{{plan}}', plan.charAt(0).toUpperCase() + plan.slice(1));
}

/** Menu template for the tray (exported for tests) */
export function buildTrayMenuTemplate(
  status: TrayStatus,
  actions: { onShowApp: () => void; onFocusWindow: (windowId: number) => void; onQuit: () => void },
  windows: TrayProjectWindow[] = [],
  text: TrayMenuLabels = labels(),
): Electron.MenuItemConstructorOptions[] {
  const info: Electron.MenuItemConstructorOptions[] = [];
  if (status.planName) info.push({ label: formatPlanLabel(status.planName, text.plan), enabled: false });
  if (status.sessionPercent != null) {
    info.push({ label: text.usage.replace('{{percent}}', String(Math.round(status.sessionPercent))), enabled: false });
  }

  // One entry per window while several projects are open; a single window keeps "Show App"
  const windowItems: Electron.MenuItemConstructorOptions[] =
    windows.length > 1
      ? windows.map((win) => ({
          label: win.projectName ?? text.noProject,
          click: () => actions.onFocusWindow(win.windowId),
        }))
      : [{ label: text.showApp, click: actions.onShowApp }];

  return [
    ...windowItems,
    ...(info.length > 0 ? [{ type: 'separator' as const }, ...info] : []),
    { type: 'separator' },
    { label: text.quit, click: actions.onQuit },
  ];
}

/** Sign-in/out has no event to listen to, so the menu is also re-checked periodically */
const TRAY_REFRESH_INTERVAL_MS = 30_000;

export class AppTray {
  private tray: Tray;
  private options: AppTrayOptions;
  private refreshTimer: ReturnType<typeof setInterval>;

  constructor(options: AppTrayOptions) {
    this.options = options;
    // macOS menu bar wants a black template image (it recolors it); other platforms get white.
    // Development builds show a hammer so they can't be mistaken for the installed app
    const suffix = options.devBuild ? '-dev' : '';
    const image = nativeImage.createFromPath(
      join(options.iconsDir, isMacOS() ? `trayTemplate${suffix}.png` : `tray-icon${suffix}.png`),
    );
    if (isMacOS()) image.setTemplateImage(true);

    this.tray = new Tray(image);
    this.tray.setToolTip(labels().tooltip);
    // Windows/macOS: clicking the icon brings the window back (Linux always opens the menu)
    if (!isMacOS()) this.tray.on('click', () => options.onShowApp());
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), TRAY_REFRESH_INTERVAL_MS);
  }

  /** Rebuild the menu with the latest plan/usage and open project windows */
  refresh(): void {
    if (this.tray.isDestroyed()) return;
    const { onShowApp, onFocusWindow, onQuit, getStatus, getWindows } = this.options;
    this.tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayMenuTemplate(getStatus(), { onShowApp, onFocusWindow, onQuit }, getWindows()),
      ),
    );
  }

  destroy(): void {
    clearInterval(this.refreshTimer);
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
