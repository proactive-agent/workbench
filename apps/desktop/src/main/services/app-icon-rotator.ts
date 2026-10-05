/**
 * App Icon Rotator
 * ================
 *
 * Cycles the application icon through user-provided images. Drop numbered PNGs
 * (1.png, 2.png, …, n.png) into the icons folder (`<userData>/app-icons`) and the
 * icon advances to the next one every interval, wrapping back to 1.png.
 *
 * The folder is re-read on every tick, so icons can be added or removed while the
 * app is running. When the folder is empty the default app icon is restored.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Folder name (inside userData) that holds the rotation icons. */
export const APP_ICONS_DIR_NAME = 'app-icons';

/** How often the icon advances. */
export const APP_ICON_ROTATION_INTERVAL_MS = 10_000;

const ICON_FILE_PATTERN = /^(\d+)\.png$/i;

/**
 * List rotation icons in numeric order (1.png, 2.png, …, 10.png).
 * Files that don't match `<number>.png` are ignored.
 */
export function listRotationIcons(iconsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(iconsDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, match: name.match(ICON_FILE_PATTERN) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => join(iconsDir, entry.name));
}

export interface AppIconRotatorDeps {
  /** Folder containing 1.png … n.png */
  iconsDir: string;
  /** Apply an icon file to the app. Returns false if the image could not be loaded. */
  applyIcon: (iconPath: string) => boolean;
  /** Restore the bundled default icon. */
  restoreDefaultIcon: () => void;
  /** Interval override for tests. */
  intervalMs?: number;
}

export class AppIconRotator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextIndex = 0;
  private usingCustomIcon = false;

  constructor(private readonly deps: AppIconRotatorDeps) {}

  /** Create the icons folder if needed, apply the first icon, and start rotating. */
  start(): void {
    if (this.timer) return;
    try {
      if (!existsSync(this.deps.iconsDir)) {
        mkdirSync(this.deps.iconsDir, { recursive: true });
      }
    } catch (error) {
      console.warn('[AppIconRotator] Could not create icons folder:', error);
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? APP_ICON_ROTATION_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Advance to the next icon (exposed for tests). */
  tick(): void {
    const icons = listRotationIcons(this.deps.iconsDir);
    if (icons.length === 0) {
      if (this.usingCustomIcon) {
        this.deps.restoreDefaultIcon();
        this.usingCustomIcon = false;
      }
      this.nextIndex = 0;
      return;
    }

    const index = this.nextIndex % icons.length;
    this.nextIndex = index + 1;
    try {
      if (this.deps.applyIcon(icons[index])) {
        this.usingCustomIcon = true;
      }
    } catch (error) {
      console.warn(`[AppIconRotator] Failed to apply icon ${icons[index]}:`, error);
    }
  }
}
