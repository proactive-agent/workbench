/**
 * Background mode: system tray icon with a small menu.
 *
 * While the tray exists, closing the main window only hides it (agents and terminals keep
 * running); "Quit" in the tray menu (or quitting from the OS) exits the app. The menu shows
 * the active Claude plan and the current 5-hour session usage when they're known.
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

export interface AppTrayOptions {
  /** Directory holding tray-icon.png / trayTemplate.png (and their @2x variants) */
  iconsDir: string;
  onShowApp: () => void;
  onQuit: () => void;
  getStatus: () => TrayStatus;
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
  actions: { onShowApp: () => void; onQuit: () => void },
  text: TrayMenuLabels = labels(),
): Electron.MenuItemConstructorOptions[] {
  const info: Electron.MenuItemConstructorOptions[] = [];
  if (status.planName) info.push({ label: formatPlanLabel(status.planName, text.plan), enabled: false });
  if (status.sessionPercent != null) {
    info.push({ label: text.usage.replace('{{percent}}', String(Math.round(status.sessionPercent))), enabled: false });
  }

  return [
    { label: text.showApp, click: actions.onShowApp },
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
    // macOS menu bar wants a black template image (it recolors it); other platforms get white
    const image = nativeImage.createFromPath(
      join(options.iconsDir, isMacOS() ? 'trayTemplate.png' : 'tray-icon.png'),
    );
    if (isMacOS()) image.setTemplateImage(true);

    this.tray = new Tray(image);
    this.tray.setToolTip(labels().tooltip);
    // Windows/macOS: clicking the icon brings the window back (Linux always opens the menu)
    if (!isMacOS()) this.tray.on('click', () => options.onShowApp());
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), TRAY_REFRESH_INTERVAL_MS);
  }

  /** Rebuild the menu with the latest plan/usage */
  refresh(): void {
    if (this.tray.isDestroyed()) return;
    const { onShowApp, onQuit, getStatus } = this.options;
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(getStatus(), { onShowApp, onQuit })));
  }

  destroy(): void {
    clearInterval(this.refreshTimer);
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
