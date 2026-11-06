/**
 * Browser profile detection
 * =========================
 *
 * Finds the installed Chromium-family browsers (Chrome, Edge, Brave, Chromium) and Firefox and
 * lists their profiles for the Playwright connector (Settings > Connectors). A profile is usable
 * when Playwright can drive the browser and its executable exists where tools run.
 *
 * When tools run in WSL, Playwright starts inside the distribution: its browsers are read through
 * `\\wsl.localhost` paths and stored with their Linux paths, and Windows browsers are listed but
 * can't be used. Only async file reads; command lookups go through mcp-commands (async, cached).
 * Runs once at startup; `refresh` looks again.
 */

import os from 'os';
import path from 'path';
import { access, readFile, readdir, stat } from 'fs/promises';
import type { BrowserProfile, BrowserProfileDisabledReason, DownloadableBrowser } from '../../shared/types/browser-profiles';
import { isMacOS, isWindows } from '../platform';
import { getWslInfo, toHostPath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { resolveCommand } from '../mcp-commands';
import { runTool } from '../platform/runtime-exec';
import { appLog } from '../app-logger';
import {
  SNAP_FIREFOX_BINARY,
  SNAP_FIREFOX_LAUNCHER,
  browserLocations,
  pathApi,
  storeFirefoxPaths,
  windowsLocalAppData,
  type BrowserLocation,
  type BrowserOs,
} from './locations';
import { parseChromiumLocalState, parseFirefoxProfilesIni } from './parsing';
import { findManagedBrowser, scanManagedBrowsers } from './managed';
import { ensureWindowsBrowserScripts } from './windows-browser';

/** Profiles with no sign of use for this long are left out (leftovers of old or removed installs) */
export const STALE_PROFILE_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Profiles no browser ever opened (none of the activity files) are left out once made this long
 * ago: Firefox's placeholder `default` profile, made on its first run next to the
 * `default-release` one it uses. A profile just made (about:profiles) is still listed
 */
export const UNOPENED_PROFILE_MS = 7 * 24 * 60 * 60 * 1000;
/** Files a browser writes while a profile is in use, relative to the profile's folder */
const ACTIVITY_FILES = [
  'Preferences', 'Cookies', 'Network/Cookies', 'History', 'Login Data',
  'prefs.js', 'cookies.sqlite', 'places.sqlite', 'sessionstore.jsonlz4',
];

/** How often, and for how long, a started download is looked for */
const WATCH_INTERVAL_MS = 3000;
const WATCH_LIMIT_MS = 15 * 60 * 1000;

const BROWSER_ORDER = ['chrome', 'edge', 'brave', 'chromium', 'firefox', 'safari', 'webkit'];

interface ScanContext {
  os: BrowserOs;
  home: string;
  env: Record<string, string | undefined>;
  /** A path from the table -> the path this process reads it with */
  toHost: (p: string) => string;
  /** Whether PATH lookups apply (they look where tools run) */
  lookUpCommands: boolean;
  /** Look commands up again instead of taking the cached answer */
  refresh?: boolean;
  /** Leave out the browsers Playwright downloads itself */
  skipManaged?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether nothing in a profile's folder changed for STALE_PROFILE_MS. Judged by the files a
 * browser writes in use (a folder's own date moves when anything is added to it); a profile
 * without any of them was never opened, and counts by its folder's date with UNOPENED_PROFILE_MS
 */
export async function isStaleProfile(profileFolder: string, now = Date.now()): Promise<boolean> {
  let newest = 0;
  for (const file of ACTIVITY_FILES) {
    try {
      newest = Math.max(newest, (await stat(`${profileFolder}/${file}`)).mtimeMs);
    } catch {
      // Not written by this browser
    }
  }
  if (newest === 0) {
    try {
      return now - (await stat(profileFolder)).mtimeMs > UNOPENED_PROFILE_MS;
    } catch {
      return false;
    }
  }
  return now - newest > STALE_PROFILE_MS;
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function findExecutable(location: BrowserLocation, context: ScanContext): Promise<string | undefined> {
  for (const candidate of location.executables) {
    if (await exists(context.toHost(candidate))) return candidate;
  }
  if (!context.lookUpCommands) return undefined;
  for (const command of location.commands ?? []) {
    const found = await resolveCommand(command, { refresh: context.refresh });
    if (found) return found;
  }
  return undefined;
}

/** Ubuntu's `/usr/bin/firefox` is a small script that starts the snap */
async function startsSnapFirefox(executable: string, context: ScanContext): Promise<boolean> {
  if (executable === SNAP_FIREFOX_LAUNCHER) return true;
  try {
    const host = context.toHost(executable);
    if ((await stat(host)).size > 64 * 1024) return false;
    const text = await readFile(host, 'utf-8');
    return text.startsWith('#!') && text.includes(SNAP_FIREFOX_LAUNCHER);
  } catch {
    return false;
  }
}

/** One check per scan: the deb and snap locations can both lead to the snap */
const snapChecks = new WeakMap<ScanContext, Promise<BrowserProfileDisabledReason | undefined>>();

/**
 * Why snap Firefox's own binary (the one runs launch, see mcp-config.ts) can't run outside the
 * snap. It is built on the snap's base (core24: glibc 2.38 or newer) and has no bundled libc, so
 * on an older system the loader refuses it
 */
function snapFirefoxProblem(context: ScanContext): Promise<BrowserProfileDisabledReason | undefined> {
  let check = snapChecks.get(context);
  if (!check) {
    check = (async () => {
      if (!(await exists(context.toHost(SNAP_FIREFOX_BINARY)))) return 'executable-missing' as const;
      try {
        // Tool name aside, this runs the given binary where tools run
        await runTool('node', ['--version'], { command: SNAP_FIREFOX_BINARY, timeout: 15_000 });
        return undefined;
      } catch (error) {
        // `version `GLIBC_2.38' not found (required by ...)`; other failures are left to the connector check
        const stderr = String((error as { stderr?: unknown }).stderr ?? '');
        return /GLIBC(?:XX)?_[\d.]+' not found/.test(stderr) ? 'snap-needs-newer-glibc' as const : undefined;
      }
    })();
    snapChecks.set(context, check);
  }
  return check;
}

/** The executable a location's profiles launch with, or why there is none that works */
async function resolveLaunch(
  location: BrowserLocation,
  context: ScanContext
): Promise<{ executablePath?: string; disabledReason?: BrowserProfileDisabledReason }> {
  if (location.disabledReason) return { disabledReason: location.disabledReason };
  const executablePath = await findExecutable(location, context);
  if (!executablePath) return { disabledReason: 'executable-missing' };
  if (context.os === 'linux' && location.engine === 'firefox' && (await startsSnapFirefox(executablePath, context))) {
    // Stored as the snap's launcher, which runs map to the snap's own binary
    const disabledReason = await snapFirefoxProblem(context);
    return { executablePath: SNAP_FIREFOX_LAUNCHER, ...(disabledReason ? { disabledReason } : {}) };
  }
  return { executablePath };
}

function profileId(location: BrowserLocation, folder: string): string {
  return `${location.browser}${location.variant ? `-${location.variant}` : ''}:${folder}`;
}

async function scanLocation(location: BrowserLocation, context: ScanContext): Promise<BrowserProfile[]> {
  const p = pathApi(context.os);
  const found: Omit<BrowserProfile, 'usable' | 'executablePath'>[] = [];

  if (location.engine === 'webkit') {
    // Safari: one entry when it is installed, never usable
    const app = location.executables[0];
    if (app && (await exists(context.toHost(app)))) {
      found.push({ id: `${location.browser}:default`, browser: location.browser, engine: location.engine, profileName: 'Safari', userDataDir: '', profilePath: '' });
    }
  }

  for (const dataDir of location.dataDirs) {
    if (location.engine === 'chromium') {
      const text = await readText(context.toHost(p.join(dataDir, 'Local State')));
      if (text === null) continue;
      for (const entry of parseChromiumLocalState(text)) {
        const profilePath = p.join(dataDir, entry.directory);
        // Listed in Local State but deleted since
        if (!(await exists(context.toHost(profilePath)))) continue;
        if (await isStaleProfile(context.toHost(profilePath))) continue;
        found.push({
          id: profileId(location, entry.directory),
          browser: location.browser,
          engine: location.engine,
          ...(location.variant ? { variant: location.variant } : {}),
          profileName: entry.name,
          ...(entry.email ? { email: entry.email } : {}),
          userDataDir: dataDir,
          profileDirectory: entry.directory,
          profilePath,
        });
      }
    } else if (location.engine === 'firefox') {
      const text = await readText(context.toHost(p.join(dataDir, 'profiles.ini')));
      if (text === null) continue;
      for (const entry of parseFirefoxProfilesIni(text, dataDir, p)) {
        if (!(await exists(context.toHost(entry.path)))) continue;
        if (await isStaleProfile(context.toHost(entry.path))) continue;
        found.push({
          id: profileId(location, entry.folder),
          browser: location.browser,
          engine: location.engine,
          ...(location.variant ? { variant: location.variant } : {}),
          profileName: entry.name,
          userDataDir: dataDir,
          profilePath: entry.path,
        });
      }
    }
  }
  if (found.length === 0) return [];

  const { executablePath, disabledReason } = await resolveLaunch(location, context);
  return found.map((profile) => ({
    ...profile,
    ...(executablePath ? { executablePath } : {}),
    usable: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
  }));
}

/**
 * The Microsoft Store packages that hold Firefox profiles, found by what they keep on disk rather
 * than by name, so any Firefox the Store installs is covered
 */
async function findStoreFirefoxPackages(context: ScanContext): Promise<string[]> {
  if (context.os !== 'windows') return [];
  const localAppData = windowsLocalAppData(context);
  let families: string[];
  try {
    families = await readdir(context.toHost(path.win32.join(localAppData, 'Packages')));
  } catch {
    return [];
  }
  const hasProfiles = await Promise.all(
    families.map((family) => exists(context.toHost(path.win32.join(storeFirefoxPaths(localAppData, family).dataDir, 'profiles.ini'))))
  );
  return families.filter((_, index) => hasProfiles[index]);
}

/** Every profile of the browsers in one OS's table; a browser that can't be read is skipped */
export async function scanBrowserProfiles(context: ScanContext): Promise<BrowserProfile[]> {
  const profiles: BrowserProfile[] = [];
  const seen = new Set<string>();
  const storePackages = await findStoreFirefoxPackages(context);
  for (const location of browserLocations(context.os, { ...context, storePackages })) {
    try {
      for (const profile of await scanLocation(location, context)) {
        if (seen.has(profile.id)) continue;
        seen.add(profile.id);
        profiles.push(profile);
      }
    } catch (error) {
      appLog.warn(`[BrowserProfiles] Could not read ${location.browser} profiles:`, error);
    }
  }
  // Grouped by browser in a fixed order; profiles keep the browser's own order
  const sorted = profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => BROWSER_ORDER.indexOf(a.profile.browser) - BROWSER_ORDER.indexOf(b.profile.browser) || a.index - b.index)
    .map(({ profile }) => profile);
  // Playwright's own downloads come last
  return context.skipManaged ? sorted : [...sorted, ...(await scanManagedBrowsers(context).catch(() => []))];
}

function nativeOs(): BrowserOs {
  if (isWindows()) return 'windows';
  if (isMacOS()) return 'macos';
  return 'linux';
}

async function detect(refresh: boolean): Promise<BrowserProfile[]> {
  await whenShellRuntimeReady();
  const wsl = getWslInfo();
  const native: ScanContext = { os: nativeOs(), home: os.homedir(), env: process.env, toHost: (p) => p, lookUpCommands: !isWindows(), refresh };
  if (!wsl) return scanBrowserProfiles(native);

  // Tools (and so Playwright) run in the distribution: its own browsers can be used; Windows Firefox
  // profiles with a Firefox there (runs copy them in, profile-copy.ts); Windows Chromium browsers
  // through the launcher (windows-browser.ts, which needs interop), signed out: their cookies are
  // encrypted with an app-bound key that only opens in the browser's own profile folder
  const linuxContext: ScanContext = { os: 'linux', home: wsl.home, env: {}, toHost: toHostPath, lookUpCommands: true, refresh };
  const linux = await scanBrowserProfiles(linuxContext);
  void ensureWindowsBrowserScripts().catch((error: unknown) => appLog.warn('[BrowserProfiles] Could not write the Windows browser launcher:', error));
  const windowsProfiles = await scanBrowserProfiles({ ...native, lookUpCommands: false, skipManaged: true });
  const firefoxes = windowsProfiles.some((profile) => profile.engine === 'firefox') ? await wslFirefoxes(linuxContext) : null;
  const windows = await Promise.all(windowsProfiles.map(async (profile): Promise<BrowserProfile> => {
    const id = `windows-${profile.id}`;
    if (profile.engine === 'chromium') {
      if (!profile.usable) return { ...profile, id };
      return wsl.interop === false
        ? { ...profile, id, usable: false, disabledReason: 'windows-browser-in-wsl' }
        : { ...profile, id, signedOut: true };
    }
    if (profile.engine !== 'firefox' || !firefoxes) return { ...profile, id, usable: false, disabledReason: 'windows-browser-in-wsl' };
    const { disabledReason: _disabledReason, ...rest } = profile;
    const executablePath = pickWslFirefox(await windowsProfileFirefoxMajor(profile.profilePath), firefoxes);
    return executablePath
      ? { ...rest, id, executablePath, usable: true }
      : { ...rest, id, executablePath: undefined, usable: false, disabledReason: 'needs-firefox-in-wsl', downloadable: 'firefox' };
  }));
  return [...linux, ...windows];
}

/** The Firefoxes in the distribution that can run a Windows Firefox profile's copy */
export interface WslFirefoxes {
  /** An installed Firefox (not the snap's: it may only read non-hidden folders), with its major version */
  installed?: { executablePath: string; major: number };
  /** Playwright's own Firefox build */
  playwright?: string;
}

/** A version's major number (`Mozilla Firefox 156.0`, `158.0.1_20261019185856/...`), or undefined */
export function majorVersion(text: string): number | undefined {
  const major = Number(/(\d+)\.\d/.exec(text)?.[1]);
  return major > 0 ? major : undefined;
}

async function wslFirefoxes(context: ScanContext): Promise<WslFirefoxes> {
  const found: WslFirefoxes = {};
  const playwright = await findManagedBrowser('firefox', context).catch(() => undefined);
  if (playwright) found.playwright = playwright;
  for (const location of browserLocations('linux', context)) {
    if (location.engine !== 'firefox' || location.variant) continue;
    const executablePath = await findExecutable(location, context);
    if (!executablePath || (await startsSnapFirefox(executablePath, context))) continue;
    try {
      // Tool name aside, this runs the given executable where tools run
      const { stdout } = await runTool('node', ['--version'], { command: executablePath, timeout: 15_000 });
      const major = majorVersion(String(stdout));
      if (major) found.installed = { executablePath, major };
    } catch {
      // Doesn't start: Playwright's Firefox, if any, runs the profiles
    }
    break;
  }
  return found;
}

/** The major version of the Firefox that last wrote a profile (its `compatibility.ini`), or undefined */
async function windowsProfileFirefoxMajor(profilePath: string): Promise<number | undefined> {
  const compatibility = await readText(pathApi('windows').join(profilePath, 'compatibility.ini'));
  return compatibility ? majorVersion(/^LastVersion=(.*)$/m.exec(compatibility)?.[1] ?? '') : undefined;
}

/**
 * The Firefox in the distribution that runs a Windows profile's copy: the installed one when it is
 * at least the version that last wrote the profile (Firefox refuses a profile a newer version
 * wrote), else Playwright's own build, which runs the copy with `--allow-downgrade` (mcp-config.ts)
 */
export function pickWslFirefox(profileMajor: number | undefined, firefoxes: WslFirefoxes): string | undefined {
  if (firefoxes.installed && (profileMajor === undefined || firefoxes.installed.major >= profileMajor)) return firefoxes.installed.executablePath;
  return firefoxes.playwright ?? firefoxes.installed?.executablePath;
}

let detection: Promise<BrowserProfile[]> | null = null;

/** The detected browser profiles (looked for once; `refresh` looks again) */
export function detectBrowserProfiles(options: { refresh?: boolean } = {}): Promise<BrowserProfile[]> {
  if (!detection || options.refresh) {
    detection = detect(options.refresh === true).catch((error: unknown) => {
      appLog.warn('[BrowserProfiles] Detection failed:', error);
      return [];
    });
  }
  return detection;
}

/** Running watches by browser, with when each gives up (each new download moves it to WATCH_LIMIT_MS from then) */
const watches = new Map<DownloadableBrowser, { deadline: number; promise: Promise<BrowserProfile[] | null> }>();

/**
 * After a download button opened a terminal: wait (up to WATCH_LIMIT_MS after the latest call) for
 * the browser's build to show up in Playwright's cache folder, then detect again and return the new
 * list (null when it never did). One watch per browser; a later call shares it and extends its deadline
 */
export function waitForManagedBrowser(browser: DownloadableBrowser): Promise<BrowserProfile[] | null> {
  const deadline = Date.now() + WATCH_LIMIT_MS;
  const running = watches.get(browser);
  if (running) {
    running.deadline = Math.max(running.deadline, deadline);
    return running.promise;
  }
  const watch: { deadline: number; promise: Promise<BrowserProfile[] | null> } = { deadline, promise: Promise.resolve(null) };
  watch.promise = (async () => {
    await whenShellRuntimeReady();
    const wsl = getWslInfo();
    const context = wsl
      ? { os: 'linux' as const, home: wsl.home, env: {}, toHost: toHostPath }
      : { os: nativeOs(), home: os.homedir(), env: process.env, toHost: (p: string) => p };
    while (Date.now() < watch.deadline) {
      if (await findManagedBrowser(browser, context)) return detectBrowserProfiles({ refresh: true });
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
    return null;
  })().finally(() => {
    watches.delete(browser);
  });
  watches.set(browser, watch);
  return watch.promise;
}
