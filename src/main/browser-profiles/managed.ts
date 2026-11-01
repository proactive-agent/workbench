/**
 * Browsers Puppeteer downloads itself
 * ===================================
 *
 * `npx puppeteer browsers install firefox` puts a browser in Puppeteer's cache folder
 * (`PUPPETEER_CACHE_DIR`, else `~/.cache/puppeteer`, on every OS), one folder per build
 * (`firefox/linux-132.0.2/...`). The picker lists Firefox as "Puppeteer's Firefox": usable once a
 * build is in the cache, otherwise disabled with a download button. Puppeteer's Chrome is the
 * picker's default entry, so it isn't listed here.
 */

import { readdir, access } from 'fs/promises';
import type { BrowserProfile } from '../../shared/types/browser-profiles';
import { pathApi, type BrowserOs } from './locations';

/** The command the download button runs (opened in a terminal by the main process) */
export const FIREFOX_INSTALL_COMMAND = 'npx puppeteer browsers install firefox';

/** Where a downloaded Firefox's executable sits inside a build's folder, per OS */
const FIREFOX_EXECUTABLES: Record<BrowserOs, string[][]> = {
  linux: [['firefox', 'firefox']],
  macos: [['Firefox.app', 'Contents', 'MacOS', 'firefox'], ['Firefox Nightly.app', 'Contents', 'MacOS', 'firefox']],
  windows: [['core', 'firefox.exe']],
};

export interface ManagedScanContext {
  os: BrowserOs;
  home: string;
  env: Record<string, string | undefined>;
  /** A path of the OS's table -> the path this process reads it with */
  toHost: (p: string) => string;
}

/** Puppeteer's cache folder where tools run */
export function puppeteerCacheDir({ os, home, env }: ManagedScanContext): string {
  return env.PUPPETEER_CACHE_DIR || pathApi(os).join(home, '.cache', 'puppeteer');
}

/**
 * Whether a build is still being unpacked: @puppeteer/browsers downloads `<buildId>-<file>` next to
 * the build's `<platform>-<buildId>` folder, unpacks it there in archive order (the executable comes
 * before the libraries) and deletes the archive only when done. Platforms (`linux`, `mac_arm`,
 * `win64`) have no dash, so the build id is what follows the first one
 */
function installing(build: string, entries: string[]): boolean {
  const dash = build.indexOf('-');
  if (dash < 0) return false;
  const archivePrefix = `${build.slice(dash + 1)}-`;
  return entries.some((entry) => entry !== build && entry.startsWith(archivePrefix));
}

/** The newest downloaded Firefox's executable (a path where tools run), or undefined */
export async function findManagedFirefox(context: ManagedScanContext): Promise<string | undefined> {
  const p = pathApi(context.os);
  const root = p.join(puppeteerCacheDir(context), 'firefox');
  let builds: string[];
  try {
    builds = await readdir(context.toHost(root));
  } catch {
    return undefined;
  }
  // `linux-132.0.2`, `linux-133.0`: newest first, by version
  builds.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const build of builds) {
    if (installing(build, builds)) continue;
    for (const parts of FIREFOX_EXECUTABLES[context.os]) {
      const executable = p.join(root, build, ...parts);
      try {
        await access(context.toHost(executable));
        return executable;
      } catch {
        // Not this layout, or an unfinished download
      }
    }
  }
  return undefined;
}

/** "Puppeteer's Firefox" for the picker: usable when downloaded, else downloadable */
export async function scanManagedBrowsers(context: ManagedScanContext): Promise<BrowserProfile[]> {
  const executablePath = await findManagedFirefox(context);
  return [{
    id: 'puppeteer:firefox',
    browser: 'firefox',
    engine: 'firefox',
    managed: true,
    profileName: 'Firefox',
    userDataDir: '',
    profilePath: '',
    ...(executablePath ? { executablePath, usable: true } : { usable: false, disabledReason: 'not-downloaded' as const, downloadable: 'firefox' as const }),
  }];
}
