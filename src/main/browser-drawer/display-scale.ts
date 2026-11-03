/**
 * The pixel density Playwright's browsers render at: the largest devicePixelRatio of the screens
 * (at most 2), so the browser drawer shows their pages as sharp as the rest of the window. Runs
 * started after a screen change use the new density; running browsers keep theirs (Playwright
 * fixes it when it launches one). Screenshots for agents stay in CSS pixels (Playwright's default).
 */

import { app, screen } from 'electron';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { appLog } from '../app-logger';
import { playwrightScaleConfig, setPlaywrightDisplayScale } from '../claude-code/mcp-config';

/** Browsers render at most this many device pixels per CSS pixel (4x the pixels at 1) */
const MAX_BROWSER_SCALE = 2;

/** The density for screens of these scale factors: the largest, within 1..MAX_BROWSER_SCALE */
export function browserScaleFor(scaleFactors: readonly number[]): number {
  const largest = Math.max(1, ...scaleFactors.filter((f) => Number.isFinite(f)));
  return Math.round(Math.min(largest, MAX_BROWSER_SCALE) * 100) / 100;
}

let applied = 1;

async function apply(): Promise<void> {
  const scale = browserScaleFor(screen.getAllDisplays().map((display) => display.scaleFactor));
  if (scale === applied) return;
  if (scale <= 1) {
    applied = 1;
    setPlaywrightDisplayScale(null);
    return;
  }
  try {
    const dir = path.join(app.getPath('userData'), 'playwright');
    await mkdir(dir, { recursive: true });
    const configFiles = {
      chromium: path.join(dir, 'display-scale-chromium.json'),
      other: path.join(dir, 'display-scale.json'),
    };
    await writeFile(configFiles.chromium, JSON.stringify(playwrightScaleConfig('chromium', scale), null, 2));
    await writeFile(configFiles.other, JSON.stringify(playwrightScaleConfig('other', scale), null, 2));
    // Only once the files are there: a run naming a missing config wouldn't start its browser
    applied = scale;
    setPlaywrightDisplayScale({ scale, configFiles });
  } catch (error) {
    appLog.warn('[BrowserDrawer] Could not write the browsers\' display scale:', error);
  }
}

let queue = Promise.resolve();
/** One update at a time, in order */
const schedule = () => {
  queue = queue.then(apply, apply);
};

/** Follow the screens' density (after app ready) */
export function watchBrowserDisplayScale(): void {
  schedule();
  screen.on('display-added', schedule);
  screen.on('display-removed', schedule);
  screen.on('display-metrics-changed', schedule);
}
