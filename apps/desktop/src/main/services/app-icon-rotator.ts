/**
 * Icon Rotator
 * ============
 *
 * Cycles the sidebar header icon through numbered PNGs (1.png, 2.png, …, n.png)
 * in `<userData>/header-icons/{dark,light}`, advancing every interval and
 * wrapping back to 1.png.
 *
 * The folder is re-read on every tick, so icons can be added or removed while the
 * app is running. When the folder is empty the default is restored.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Folder name (inside userData) that holds the sidebar header icons. */
export const HEADER_ICONS_DIR_NAME = 'header-icons';

/** Header icons have one set per appearance mode: header-icons/dark and header-icons/light. */
export const HEADER_ICON_MODES = ['dark', 'light'] as const;
export type HeaderIconMode = (typeof HEADER_ICON_MODES)[number];

/** How often the sidebar header icon advances. */
export const HEADER_ICON_ROTATION_INTERVAL_MS = 5_000;

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

/** Marker written after bundled icons were copied, so a folder emptied on purpose stays empty. */
export const SEEDED_MARKER_FILE = '.seeded';

/**
 * Copy the icons bundled with the app (resources/<folder>) into the user's icons
 * folder the first time it is empty, so a fresh install shows them automatically.
 * Existing user icons are never overwritten.
 *
 * @returns Number of icons copied.
 */
export function seedRotationIcons(bundledDir: string, iconsDir: string): number {
  if (existsSync(join(iconsDir, SEEDED_MARKER_FILE))) return 0;
  if (listRotationIcons(iconsDir).length > 0) return 0;

  const bundled = listRotationIcons(bundledDir);
  if (bundled.length === 0) return 0;

  mkdirSync(iconsDir, { recursive: true });
  for (const iconPath of bundled) {
    copyFileSync(iconPath, join(iconsDir, basename(iconPath)));
  }
  writeFileSync(join(iconsDir, SEEDED_MARKER_FILE), new Date().toISOString());
  return bundled.length;
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
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? HEADER_ICON_ROTATION_INTERVAL_MS);
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
