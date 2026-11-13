/**
 * Copies of browser profiles for Playwright runs
 * ==============================================
 *
 * A run never drives the user's real profile folder: Chrome 136+ refuses remote debugging on its
 * default user data folder, and a browser that is open holds a lock on it. Each run gets a copy in
 * the app's own data folder, `<userData>/browser-profiles/<project>/<profile>/<slot>` (a slot per
 * task run or chat turn), so parallel runs never share a folder. Copies stay out of the project:
 * they hold cookies and sign-ins, and the project is what Claude Code sessions (the read-only
 * Claude chat too) can read. In WSL the browsers are Linux ones, so the copies live in the
 * distribution's home (`~/.cache/workbench/browser-profiles`), where the browser reads them
 * natively. A browser that runs confined in its snap (snap Chromium, locations.ts) may write only
 * its own `~/snap/<name>`, so its copies live in `~/snap/<name>/common/workbench-profiles`. Caches,
 * locks, the session to restore and Firefox's Sync account are left out; files a running browser
 * keeps locked (Windows) are skipped, so closing the browser first copies every sign-in. The folders
 * are private (0700) where the filesystem keeps modes; in WSL they are made private from inside
 * the distribution, since modes set over `\\wsl.localhost` don't apply.
 *
 * Each copy names the Workbench process that made it (folder-owner.ts's OWNER_FILE: pid, plus the process's start
 * on Linux), since two Workbench processes can share the data folder (`npm run dev` next to the
 * installed app). The owner refreshes the file's time while the copy is in use, so where a
 * process can't be told from one that later took its id (off Linux), a claim not refreshed for an
 * hour has ended. Copies no live run uses are removed: at startup (all of them, in every place
 * above, and on Windows also in a running WSL distribution's home after a switch back from WSL,
 * except copies another running Workbench owns), on quit (those of runs still going, such as
 * chat turns), at once when no one chooses their profile any more, and after a day
 * otherwise; a copy whose owner is another live Workbench process is never swept.
 *
 * Each profile also has one saved copy (`<base>/_saved/<profile>/<time>`), made in the background
 * whenever a run or a look at the browser finds it closed (at most every SAVED_REFRESH_MS). A run
 * that starts while the browser is open copies the saved copy instead of the live profile, which
 * the open browser keeps locked and half written; only without a saved copy does an open browser
 * keep Playwright from runs (browserProfileCopyBlocked). The saved copy is kept while anyone
 * chooses the profile: Settings > Browser or a task's or chat's own pick (listed by
 * choices-in-use.ts); a project's run copies likewise go at once only when neither Settings nor
 * the project's tasks and chats choose their profile.
 *
 * A Chromium copy keeps the user data folder's layout (`Local State`, which holds the cookie key
 * on Windows, plus the profile's folder), so the same browser can still decrypt its cookies.
 *
 * Each run copy also holds the run's Playwright config (PLAYWRIGHT_CONFIG_FILE, mcp-config.ts:
 * the browser, its executable and the copy as its profile), passed to the server with `--config`
 * and removed with the copy.
 */

import path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { app } from 'electron';
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'fs/promises';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { getWslInfo, toHostPath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { isLinux, isWindows } from '../platform';
import { isWslUncPath, windowsPathKey, wslToWindows } from '../platform/wsl-paths';
import { checkWslAvailable, decodeWslOutput, getWslExePath, parseDistroList } from '../platform/wsl-detect';
import { runTool } from '../platform/runtime-exec';
import { CONFINED_SNAPS, confinedSnapName } from './locations';
import { isBrowserProfileInUse } from './in-use';
import { ensureWindowsBrowserScripts, isWindowsBrowserInWsl } from './windows-browser';
import { PLAYWRIGHT_CONFIG_FILE, playwrightProfileConfig, type PlaywrightProfileOptions } from '../claude-code/mcp-config';
import { appLog } from '../app-logger';
import { claimFolder, folderClaim, releaseFolder, writeOwner } from '../folder-owner';

/** Folders and files (relative to the profile, with `/`) a copy leaves out */
const SKIPPED_PATHS = new Set([
  // Chromium: the session to restore (a copy would reopen the user's tabs), extensions, models
  'Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs',
  'Extensions', 'optimization_guide_model_store',
  // Firefox: the session to restore, the Sync account, crash and telemetry data, locks
  'sessionstore.jsonlz4', 'sessionstore-backups', 'signedInUser.json', 'weave',
  'startupCache', 'thumbnails', 'crashes', 'minidumps', 'datareporting', 'saved-telemetry-pings',
  'parent.lock', '.parentlock', 'lock',
]);
/** Folders left out wherever they are: caches (Firefox's `storage/default/<site>/cache` too) */
const SKIPPED_FOLDERS = new Set([
  // Chromium
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache',
  'GraphiteDawnCache', 'ShaderCache', 'CacheStorage', 'ScriptCache',
  // Firefox
  'cache', 'cache2',
]);
/** File names left out wherever they are */
const SKIPPED_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', '.workbench-saved-complete']);
/** Errors from files a running browser holds, or that vanished during the copy */
const SKIPPABLE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
/** Copies are private: they hold the user's cookies */
const PRIVATE_MODE = 0o700;
/** chmod errors from filesystems that can't hold modes (FAT, CIFS mounts owned by root) */
const MODELESS_ERRORS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']);
/** How long quitting waits for the copies of runs still going to be removed */
const QUIT_REMOVE_LIMIT_MS = 3000;
/** A copy no live run uses is removed once it is this old (a crash, or another choice's copy) */
const STALE_COPY_AGE_MS = 24 * 60 * 60 * 1000;
/** How often a project's old copies are looked for */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How long listing WSL's running distributions may take (it doesn't start one) */
const WSL_LIST_TIMEOUT_MS = 10_000;
/** How long making a WSL copy private from inside the distribution may take */
const WSL_CHMOD_TIMEOUT_MS = 15_000;

/** Copies made or being made for runs of this app session (host paths), never swept */
const liveCopies = new Set<string>();
/**
 * Copies of chat browsers that closed when Workbench stopped unexpectedly, kept for their chats
 * to open again (chat-browser-restore.ts): never swept, and not removed on quit
 */
const keptCopies = new Set<string>();
/** Where the saved copies live, under each copies base (never a project's folder: no hash suffix) */
const SAVED_FOLDER = '_saved';
/** Written into a saved copy once it is complete */
const SAVED_COMPLETE = '.workbench-saved-complete';
/** How old a saved copy may get before a closed browser's profile is saved again */
const SAVED_REFRESH_MS = 5 * 60 * 1000;
/** A saved copy being written, by profile id */
const savedRefreshes = new Map<string, Promise<void>>();
/** Saved copies runs of this process are copying from now (not removed while read) */
const savedReaders = new Map<string, number>();
const lastSweep = new Map<string, number>();

/**
 * Whether another Workbench process that still runs owns this copy, so a sweep must leave it. A
 * copy without an owner file (an earlier version's, or one being set up) counts as owned while it
 * is recent. This process's own copies don't count: liveCopies says which of them are in use
 */
async function ownedByAnotherProcess(dir: string): Promise<boolean> {
  return (await folderClaim(dir)) === 'live';
}



/** A folder name for a profile id (`chrome:Profile 1` -> `chrome_Profile_1`) */
function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** The app's own folder for copies outside WSL */
function nativeCopiesBase(): string {
  return path.join(app.getPath('userData'), 'browser-profiles');
}

/** Copies in a Linux home (paths as the runtime sees them) */
const LINUX_COPIES = ['.cache', 'workbench', 'browser-profiles'];
/** A confined snap's copies in a Linux home: its own writable folder */
const snapCopies = (name: string) => ['snap', name, 'common', 'workbench-profiles'];

/** The home where the runtime's browsers run (runtime path): the distribution's in WSL, else this user's on Linux */
function runtimeLinuxHome(): string | undefined {
  const wsl = getWslInfo();
  if (wsl?.home) return wsl.home;
  return isLinux() ? homedir() : undefined;
}

/** Where every project's copies live (host path): the distribution's home in WSL, where its browsers run */
function copiesBase(): string {
  const wsl = getWslInfo();
  if (wsl?.home) return toHostPath(path.posix.join(wsl.home, ...LINUX_COPIES));
  return nativeCopiesBase();
}

/**
 * Where a browser's copies live (host path): a confined snap's own folder, the app's own folder for
 * a Windows browser while tools run in WSL (the browser runs on Windows and reads it natively), or
 * copiesBase()
 */
function copiesBaseFor(choice: PlaywrightBrowserChoice | undefined): string {
  if (isWindowsBrowserInWsl(choice)) return nativeCopiesBase();
  const snap = choice ? confinedSnapName(choice.executablePath) : undefined;
  const home = snap ? runtimeLinuxHome() : undefined;
  if (snap && home) return toHostPath(path.posix.join(home, ...snapCopies(snap)));
  return copiesBase();
}

/**
 * Every place this runtime keeps copies (host paths): copiesBase(), the confined snaps' folders and,
 * in WSL, the app's own folder (Windows browsers' copies)
 */
function runtimeCopiesBases(): string[] {
  const home = runtimeLinuxHome();
  const snaps = home ? CONFINED_SNAPS.map((name) => toHostPath(path.posix.join(home, ...snapCopies(name)))) : [];
  return [copiesBase(), ...snaps, ...(getWslInfo() ? [nativeCopiesBase()] : [])];
}

/** `wsl.exe` with these arguments (it doesn't start a distribution to list them): its output, or null */
function runWslExe(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      getWslExePath(),
      args,
      { encoding: 'buffer', timeout: WSL_LIST_TIMEOUT_MS, windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } },
      (error, stdout) => resolve(error ? null : decodeWslOutput(stdout))
    );
  });
}

/**
 * Native Windows: where WSL sessions kept copies (`~/.cache/workbench/browser-profiles` and the
 * confined snaps' folders in each home of each running distribution, as host paths), so copies
 * left before switching Shell back to PowerShell are swept too. A stopped distribution is left
 * alone: reaching its files would start it
 */
async function wslLeftoverBases(): Promise<string[]> {
  if (!isWindows() || getWslInfo()) return [];
  const availability = await checkWslAvailable();
  if (!availability.available) return [];
  const listed = await runWslExe(['-l', '--running', '-q']);
  if (listed === null) return [];
  const bases: string[] = [];
  for (const distro of parseDistroList(listed).filter((name) => availability.distros.includes(name))) {
    const toHost = (linuxPath: string) => wslToWindows(linuxPath, { distro });
    let users: string[];
    try {
      users = await readdir(toHost('/home'));
    } catch {
      users = [];
    }
    const homes = [...users.map((user) => path.posix.join('/home', user)), '/root'];
    for (const home of homes) {
      bases.push(toHost(path.posix.join(home, ...LINUX_COPIES)));
      for (const snap of CONFINED_SNAPS) bases.push(toHost(path.posix.join(home, ...snapCopies(snap))));
    }
  }
  return bases;
}

/** A project's folder among the copies: its name plus a hash of its path */
function projectFolder(projectPath: string): string {
  const key = isWindows() ? windowsPathKey(projectPath) : path.resolve(projectPath);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${slug(path.basename(projectPath)).slice(0, 40) || 'project'}-${hash}`;
}

/** Where a project's copies of this browser's profiles live (host path; any browser outside a snap without one) */
export function browserProfileCopiesRoot(projectPath: string, choice?: PlaywrightBrowserChoice): string {
  return path.join(copiesBaseFor(choice), projectFolder(projectPath));
}

/** Where earlier versions kept a project's copies, inside the project */
function legacyCopiesRoot(projectPath: string): string {
  return path.join(projectPath, '.workbench', 'browser-profiles');
}

/** Where a slot's copy of a profile lives (host path) */
export function browserProfileCopyDir(projectPath: string, choice: PlaywrightBrowserChoice, slot: string): string {
  return path.join(browserProfileCopiesRoot(projectPath, choice), slug(choice.id), slug(slot));
}

/** Make a folder private; best effort where the filesystem can't hold modes */
async function makePrivate(dir: string): Promise<void> {
  try {
    await chmod(dir, PRIVATE_MODE);
  } catch (error) {
    if (!MODELESS_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

/**
 * Make folders private. In WSL (`\\wsl.localhost` paths) chmod from Windows has no effect, so
 * chmod runs inside the distribution; best effort there (a copy still works without it)
 */
async function makeFoldersPrivate(dirs: string[]): Promise<void> {
  if (getWslInfo() && dirs.every(isWslUncPath)) {
    try {
      // Tool name aside, this runs /bin/chmod in the distribution (runTool translates the paths)
      await runTool('node', ['700', ...dirs], { command: '/bin/chmod', timeout: WSL_CHMOD_TIMEOUT_MS });
    } catch (error) {
      appLog.warn('[BrowserProfiles] Could not make the profile copy private in WSL:', error);
    }
    return;
  }
  for (const dir of dirs) await makePrivate(dir);
}

interface CopyTreeOptions {
  /** A folder (relative, with `/`) copied whole although SKIPPED_* list it: an extensions folder, where every file counts */
  whole?: string;
  /** A folder (relative, with `/`) left out */
  without?: string;
}

/**
 * Copy a folder, leaving out SKIPPED_* (inside `whole` only symlinks) and files that can't be read;
 * returns how many were skipped
 */
async function copyTree(source: string, target: string, relative = '', options: CopyTreeOptions = {}, whole = false): Promise<number> {
  await mkdir(target, { recursive: true, mode: PRIVATE_MODE });
  let skipped = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    // Symlinks are locks (Firefox's `lock`, Chromium's Singleton*) or point outside the profile
    if (entry.isSymbolicLink()) continue;
    const inWhole = whole || rel === options.whole;
    if (!inWhole) {
      if (rel === options.without || SKIPPED_PATHS.has(rel) || SKIPPED_NAMES.has(entry.name)) continue;
      if (entry.isDirectory() && SKIPPED_FOLDERS.has(entry.name)) continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) skipped += await copyTree(from, to, rel, options, inWhole);
      else if (entry.isFile()) await copyFile(from, to);
    } catch (error) {
      if (!SKIPPABLE_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      skipped++;
    }
  }
  return skipped;
}

/** Turn off "Continue where you left off" and startup pages in a Chromium copy's Preferences */
async function disableSessionRestore(preferencesFile: string): Promise<void> {
  try {
    const prefs = JSON.parse(await readFile(preferencesFile, 'utf-8')) as Record<string, unknown>;
    const session = (prefs.session && typeof prefs.session === 'object' ? prefs.session : {}) as Record<string, unknown>;
    // 5: open the New Tab page
    prefs.session = { ...session, restore_on_startup: 5, startup_urls: [] };
    await writeFile(preferencesFile, JSON.stringify(prefs));
  } catch {
    // No Preferences (or unreadable): the browser starts with its defaults
  }
}

/**
 * Where a profile keeps its extensions (relative, with `/`): in a copy, or in the profile itself
 * (Chromium's profile folder is a folder inside its copies)
 */
function extensionsPath(choice: PlaywrightBrowserChoice, inCopy: boolean): string {
  if (choice.engine !== 'chromium') return 'extensions';
  return inCopy ? `${choice.profileDirectory ?? 'Default'}/Extensions` : 'Extensions';
}

/** A copy with the profile's extensions, whole, or without them */
function extensionsCopyOptions(choice: PlaywrightBrowserChoice, extensions: boolean, inCopy: boolean): CopyTreeOptions {
  const rel = extensionsPath(choice, inCopy);
  return extensions ? { whole: rel } : { without: rel };
}

/**
 * Copy a profile into `target` in the layout runs use, with its extensions or without; returns how
 * many files were skipped
 */
async function copyProfileInto(choice: PlaywrightBrowserChoice, source: string, target: string, extensions: boolean): Promise<number> {
  const options = extensionsCopyOptions(choice, extensions, false);
  if (choice.engine !== 'chromium') return copyTree(source, target, '', options);
  const profileDirectory = choice.profileDirectory ?? 'Default';
  let skipped = await copyTree(source, path.join(target, profileDirectory), '', options);
  await disableSessionRestore(path.join(target, profileDirectory, 'Preferences'));
  try {
    await copyFile(path.join(toHostPath(choice.userDataDir), 'Local State'), path.join(target, 'Local State'));
  } catch {
    skipped++;
  }
  // No first-run pages in the copy
  await writeFile(path.join(target, 'First Run'), '');
  return skipped;
}

/** Where a profile's saved copies live (host path): one folder per save, named by its time */
function savedProfileDir(choice: PlaywrightBrowserChoice): string {
  return path.join(copiesBaseFor(choice), SAVED_FOLDER, slug(choice.id));
}

/** The newest complete saved copy of a profile, or null */
async function newestSavedCopy(choice: PlaywrightBrowserChoice): Promise<{ dir: string; at: number } | null> {
  const parent = savedProfileDir(choice);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return null;
  }
  const times = names.filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
  for (const at of times) {
    const dir = path.join(parent, String(at));
    try {
      await stat(path.join(dir, SAVED_COMPLETE));
      return { dir, at };
    } catch {
      // Still being written, or left unfinished
    }
  }
  return null;
}

/**
 * Whether runs can't get a usable copy of the profile now: the browser is open (its files locked
 * and half written) and no saved copy exists. A closed browser's profile is saved meanwhile, so
 * once it has been closed, runs work while it is open again
 */
export async function browserProfileCopyBlocked(choice: PlaywrightBrowserChoice): Promise<boolean> {
  if (choice.managed) return false;
  if (!(await isBrowserProfileInUse(choice))) {
    void refreshSavedBrowserProfileCopy(choice);
    return false;
  }
  return (await newestSavedCopy(choice)) === null;
}

/**
 * Save a copy of a closed browser's profile (at most every SAVED_REFRESH_MS, one at a time per
 * profile). A save is dropped when files couldn't be read or the browser opened meanwhile; older
 * saves go once the new one is complete. Best effort, never thrown
 */
export function refreshSavedBrowserProfileCopy(choice: PlaywrightBrowserChoice): Promise<void> {
  if (choice.managed) return Promise.resolve();
  const running = savedRefreshes.get(choice.id);
  if (running) return running;
  const promise = (async () => {
    const newest = await newestSavedCopy(choice);
    if (newest && Date.now() - newest.at < SAVED_REFRESH_MS) return;
    if (await isBrowserProfileInUse(choice).catch(() => true)) return;
    const source = toHostPath(choice.profilePath);
    const parent = savedProfileDir(choice);
    const dir = path.join(parent, String(Date.now()));
    try {
      await mkdir(dir, { recursive: true, mode: PRIVATE_MODE });
      await makeFoldersPrivate([path.dirname(path.dirname(parent)), path.dirname(parent), parent, dir]);
      // With the extensions, so a run copying it while the browser is open gets the ones its
      // settings name (the live profile's may have been updated since)
      const skipped = await copyProfileInto(choice, source, dir, true);
      if (skipped > 0 || (await isBrowserProfileInUse(choice).catch(() => true))) {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      await writeFile(path.join(dir, SAVED_COMPLETE), '');
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      appLog.warn(`[BrowserProfiles] Could not save a copy of ${choice.id}:`, error);
      return;
    }
    await removeSavedCopies(parent, dir);
  })().finally(() => savedRefreshes.delete(choice.id));
  savedRefreshes.set(choice.id, promise);
  return promise;
}

/** Remove the saves in `parent` except `keep` and those being read (best effort) */
async function removeSavedCopies(parent: string, keep?: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(parent, name);
    if (dir === keep || savedReaders.has(dir)) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!keep) await rmdir(parent).catch(() => undefined);
}

/**
 * Remove saved copies of profiles not in `keep` (every one when it is empty): no one chooses them
 * any more. Saves being written now are left alone. Best effort
 */
async function removeOtherSavedCopies(keep: PlaywrightBrowserChoice[]): Promise<void> {
  const kept = new Set(keep.map((choice) => slug(choice.id)));
  for (const base of new Set(runtimeCopiesBases())) {
    const savedRoot = path.join(base, SAVED_FOLDER);
    let profiles: string[];
    try {
      profiles = await readdir(savedRoot);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      if (kept.has(profile)) continue;
      const writing = [...savedRefreshes.keys()].some((id) => slug(id) === profile);
      if (!writing) await removeSavedCopies(path.join(savedRoot, profile));
    }
  }
}

/** The profiles still chosen, whose copies a sweep keeps (choices-in-use.ts) */
export interface BrowserChoicesInUse {
  /** Chosen for runs in this project: Settings > Browser and the project's tasks and chats */
  project: PlaywrightBrowserChoice[];
  /** Chosen anywhere: Settings and every project's tasks and chats (saved copies are shared by projects) */
  all: PlaywrightBrowserChoice[];
}

/**
 * Make a fresh copy of the chosen profile for a run and return its folder (host path), or null
 * when the profile is gone or the browser is Playwright's own download (the run then uses the
 * browser with a new profile). The copy holds the run's Playwright config (PLAYWRIGHT_CONFIG_FILE). A copy that fails (a full disk) is removed before the error is
 * thrown. The copy counts as live until removeBrowserProfileCopy. Copies of profiles no one
 * chooses any more (not in `inUse`, nor this run's) are swept meanwhile
 */
export async function prepareBrowserProfileCopy(
  projectPath: string,
  choice: PlaywrightBrowserChoice,
  slot: string,
  inUse: BrowserChoicesInUse = { project: [], all: [] },
  options: PlaywrightProfileOptions = {}
): Promise<string | null> {
  // Playwright's own download has no profile: it starts the browser with a new one
  // Not awaited: the run doesn't need it. Without a profile to copy, no copy is kept for this run
  if (choice.managed) {
    void removeOldBrowserProfileCopies(projectPath, { keep: inUse.project, keepSaved: inUse.all });
    return null;
  }
  // A Windows browser in WSL starts through the launcher, which the run's config names
  if (isWindowsBrowserInWsl(choice)) await ensureWindowsBrowserScripts();
  const source = toHostPath(choice.profilePath);
  try {
    if (!(await stat(source)).isDirectory()) throw new Error('not a folder');
  } catch {
    appLog.warn(`[BrowserProfiles] ${choice.id} not found at ${source}; Playwright uses the browser with a new profile`);
    void removeOldBrowserProfileCopies(projectPath, { keep: inUse.project, keepSaved: inUse.all });
    return null;
  }
  const target = browserProfileCopyDir(projectPath, choice, slot);
  // A chat browser's copy holds the profile's extensions or none (Settings > Browser); a task run's
  // as before: Firefox's (Playwright runs them), never Chromium's (Playwright switches them off)
  const extensions = options.extensions ?? choice.engine !== 'chromium';
  liveCopies.add(target);
  claimFolder(target);
  void removeOldBrowserProfileCopies(projectPath, { keep: [...inUse.project, choice], keepSaved: [...inUse.all, choice] });
  let skipped: number;
  try {
    await rm(target, { recursive: true, force: true });
    // The slot first (with its parents), so a sweep never finds its parents empty; then the owner
    await mkdir(target, { recursive: true, mode: PRIVATE_MODE });
    await writeOwner(target);
    // Private all the way down, also for folders made before copies were private
    const projectRoot = browserProfileCopiesRoot(projectPath, choice);
    await makeFoldersPrivate([path.dirname(projectRoot), projectRoot, path.dirname(target), target]);
    // The browser is open: the saved copy (consistent), when there is one, instead of the live profile
    const saved = (await isBrowserProfileInUse(choice).catch(() => false)) ? await newestSavedCopy(choice) : null;
    if (saved) {
      savedReaders.set(saved.dir, (savedReaders.get(saved.dir) ?? 0) + 1);
      try {
        skipped = await copyTree(saved.dir, target, '', extensionsCopyOptions(choice, extensions, true));
      } finally {
        const readers = (savedReaders.get(saved.dir) ?? 1) - 1;
        if (readers > 0) savedReaders.set(saved.dir, readers);
        else savedReaders.delete(saved.dir);
      }
      appLog.info(`[BrowserProfiles] ${choice.id} is open; this run uses its copy saved ${new Date(saved.at).toISOString()}`);
    } else {
      skipped = await copyProfileInto(choice, source, target, extensions);
      // Closed now: keep the saved copy fresh for runs that start while it is open
      void refreshSavedBrowserProfileCopy(choice);
    }
    // The run's Playwright config: this copy as the browser's profile
    await writePlaywrightProfileConfig(choice, target, options);
  } catch (error) {
    // A full disk (ENOSPC, EDQUOT) or another error: no partial copy is left behind
    await removeBrowserProfileCopy(target);
    throw error;
  }
  if (skipped > 0) {
    appLog.warn(`[BrowserProfiles] ${skipped} file(s) of ${choice.id} could not be copied (is the browser open?)`);
  }
  return target;
}

async function writePlaywrightProfileConfig(choice: PlaywrightBrowserChoice, target: string, options: PlaywrightProfileOptions): Promise<void> {
  await writeFile(path.join(target, PLAYWRIGHT_CONFIG_FILE), JSON.stringify(playwrightProfileConfig(choice, target, options), null, 2), { mode: 0o600 });
}

/**
 * A kept copy (a crashed chat browser's, started again) follows Settings > Browser's switch as it
 * is now: without extensions their folder goes (Playwright's Firefox runs a profile's extensions
 * whatever its prefs say); with them a copy that has none takes them from the closed browser's
 * profile, or its saved copy while it is open, kept only when every file came across (a half
 * copied extension is a corrupted one). Rewrites the copy's Playwright config
 */
export async function setBrowserProfileCopyExtensions(choice: PlaywrightBrowserChoice, target: string, extensions: boolean): Promise<void> {
  const folder = path.join(target, ...extensionsPath(choice, true).split('/'));
  let present = await stat(folder).then(() => true, () => false);
  if (!extensions && present) {
    await rm(folder, { recursive: true, force: true });
    present = false;
  } else if (extensions && !present) {
    present = await copyExtensionsInto(choice, folder);
  }
  await writePlaywrightProfileConfig(choice, target, { extensions: extensions && present });
}

/** Copy the profile's extensions folder to `folder`, whole or not at all; whether it was copied */
async function copyExtensionsInto(choice: PlaywrightBrowserChoice, folder: string): Promise<boolean> {
  const saved = (await isBrowserProfileInUse(choice).catch(() => true)) ? await newestSavedCopy(choice) : null;
  if (saved) savedReaders.set(saved.dir, (savedReaders.get(saved.dir) ?? 0) + 1);
  const source = saved
    ? path.join(saved.dir, ...extensionsPath(choice, true).split('/'))
    : path.join(toHostPath(choice.profilePath), extensionsPath(choice, false));
  const partial = `${folder}.partial`;
  try {
    await rm(partial, { recursive: true, force: true });
    const skipped = await copyTree(source, partial, '', {}, true);
    if (skipped > 0) throw new Error(`${skipped} file(s) could not be copied`);
    await rename(partial, folder);
    return true;
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    // A profile without extensions has no such folder
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') appLog.warn(`[BrowserProfiles] Could not copy the extensions of ${choice.id}:`, error);
    return false;
  } finally {
    if (saved) {
      const readers = (savedReaders.get(saved.dir) ?? 1) - 1;
      if (readers > 0) savedReaders.set(saved.dir, readers);
      else savedReaders.delete(saved.dir);
    }
  }
}

/** Whether a sweep may remove this copy: no run of this process uses it and no other running Workbench owns it */
async function removable(dir: string): Promise<boolean> {
  return !liveCopies.has(dir) && !keptCopies.has(dir) && !(await ownedByAnotherProcess(dir));
}

/**
 * Remove a profile's copies whose slot starts with `prefix`, except `keep`, live runs' copies and
 * other running Workbench processes' (copies left by earlier runs of a task that never cleaned up,
 * such as after a crash). Best effort
 */
export async function removeStaleBrowserProfileCopies(
  projectPath: string,
  choice: PlaywrightBrowserChoice,
  prefix: string,
  keep: string
): Promise<void> {
  const parent = path.dirname(browserProfileCopyDir(projectPath, choice, keep));
  const keepName = path.basename(browserProfileCopyDir(projectPath, choice, keep));
  const slugPrefix = slug(prefix);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name !== keepName && name.startsWith(slugPrefix))
      .map(async (name) => {
        const dir = path.join(parent, name);
        if ((await removable(dir)) && !liveCopies.has(dir)) await removeBrowserProfileCopy(dir);
      })
  );
}

export interface BrowserProfileSweepOptions {
  /** Look even when this project was looked at less than an hour ago */
  force?: boolean;
  /**
   * The profiles runs in this project still choose: their copies are kept for a day, other
   * profiles' (no one chooses them any more) go at any age; empty: every copy goes. Unset: every
   * copy is kept for a day
   */
  keep?: PlaywrightBrowserChoice[];
  /**
   * The profiles chosen anywhere, whose saved copies stay (others' go). Unset: `keep`, or with
   * neither set, saved copies are left alone
   */
  keepSaved?: PlaywrightBrowserChoice[];
  /** Every copy no live run uses goes, whatever its age (at startup, before anything runs) */
  all?: boolean;
}

/**
 * Remove the copies under `root` (`<root>/<profile>/<slot>`) that no live run uses and no other
 * running Workbench owns: older than a day, or as `options` says
 */
async function sweepCopies(root: string, options: BrowserProfileSweepOptions): Promise<void> {
  const now = Date.now();
  const kept = options.keep ? new Set(options.keep.map((choice) => slug(choice.id))) : undefined;
  let profiles: string[];
  try {
    profiles = await readdir(root);
  } catch {
    return;
  }
  for (const profile of profiles) {
    const anyAge = options.all === true || (kept !== undefined && !kept.has(profile));
    let slots: string[];
    try {
      slots = await readdir(path.join(root, profile));
    } catch {
      continue;
    }
    for (const slot of slots) {
      const dir = path.join(root, profile, slot);
      if (liveCopies.has(dir)) continue;
      if (!anyAge) {
        try {
          if (now - (await stat(dir)).mtimeMs < STALE_COPY_AGE_MS) continue;
        } catch {
          continue;
        }
      }
      if (!(await removable(dir))) continue;
      // A run may have started in this slot while it was being checked
      if (!liveCopies.has(dir)) await removeBrowserProfileCopy(dir);
    }
  }
}

/**
 * Remove a project's copies that no live run uses (nor another running Workbench): older than a
 * day, or as `options` says (left by a crash, a deleted task or a browser no one chooses any more).
 * At most once an hour per project and set of chosen profiles unless `force`. Best effort
 */
export async function removeOldBrowserProfileCopies(projectPath: string, options: BrowserProfileSweepOptions = {}): Promise<void> {
  const now = Date.now();
  const keepSaved = options.keepSaved ?? options.keep;
  const profileKey = (list: PlaywrightBrowserChoice[] | undefined) =>
    list === undefined ? '' : `[${[...new Set(list.map((choice) => slug(choice.id)))].sort().join(',')}]`;
  // A changed choice is looked at again at once; a sweep in WSL looks at other folders than one
  // run natively (chat browsers on Windows, runNatively)
  const sweepKey = `${getWslInfo() ? 'wsl' : 'native'}\0${projectPath}\0${profileKey(options.keep)}\0${profileKey(keepSaved)}`;
  if (!options.force && now - (lastSweep.get(sweepKey) ?? 0) < SWEEP_INTERVAL_MS) return;
  lastSweep.set(sweepKey, now);
  if (keepSaved !== undefined) await removeOtherSavedCopies(keepSaved);
  // Every place copies may be: a confined snap's folder too, after a choice of another browser
  for (const base of new Set(runtimeCopiesBases())) {
    await sweepCopies(path.join(base, projectFolder(projectPath)), options);
  }
}

/** Remove `dir` and the folders under it that are empty (best effort; leaves anything with files) */
async function removeEmptyFolders(dir: string, depth: number): Promise<void> {
  if (depth > 0) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) await removeEmptyFolders(path.join(dir, name), depth - 1);
  }
  await rmdir(dir).catch(() => undefined);
}

/**
 * At startup: remove every copy no other running Workbench owns (nothing of this process runs
 * yet, so they are left by a crash, a quit during a run, a cleanup that didn't finish or a project
 * since removed), and the copies earlier versions kept inside the given projects
 * (`.workbench/browser-profiles`). Not awaited by startup; one folder at a time. Best effort
 */
export async function removeLeftoverBrowserProfileCopies(projectPaths: string[]): Promise<void> {
  await whenShellRuntimeReady();
  const bases = new Set<string>();
  try {
    // The current places and, in WSL, the native one (a session from before a runtime switch)
    for (const base of runtimeCopiesBases()) bases.add(base);
    bases.add(nativeCopiesBase());
    // Natively on Windows, a running distribution's (a WSL session from before the switch)
    for (const base of await wslLeftoverBases()) bases.add(base);
  } catch (error) {
    appLog.warn('[BrowserProfiles] Could not find the folder of profile copies:', error);
  }
  const roots: string[] = [];
  for (const base of bases) {
    try {
      // The saved copies are kept across sessions
      roots.push(...(await readdir(base)).filter((name) => name !== SAVED_FOLDER).map((name) => path.join(base, name)));
    } catch {
      // No copies there yet
    }
  }
  for (const root of roots) {
    await sweepCopies(root, { all: true }).catch((error: unknown) => {
      appLog.warn(`[BrowserProfiles] Could not clean up copies in ${root}:`, error);
    });
  }
  for (const projectPath of new Set(projectPaths)) {
    const legacy = legacyCopiesRoot(projectPath);
    await sweepCopies(legacy, { all: true })
      .then(() => removeEmptyFolders(legacy, 1))
      .catch((error: unknown) => {
        appLog.warn(`[BrowserProfiles] Could not clean up copies in ${legacy}:`, error);
      });
  }
}

/**
 * On quit: remove the copies of runs still going (chat turns aren't stopped by quitting), waiting
 * at most `limitMs`; what a browser still holds is left to the next startup. Best effort
 */
export async function removeLiveBrowserProfileCopies(limitMs = QUIT_REMOVE_LIMIT_MS): Promise<void> {
  if (liveCopies.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...liveCopies].map((dir) => removeBrowserProfileCopy(dir))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limitMs);
    }),
  ]);
  clearTimeout(timer);
}

/** Remove a run's copy (best effort: a browser that is still closing may hold files) */
export async function removeBrowserProfileCopy(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (error) {
    appLog.warn(`[BrowserProfiles] Could not remove ${dir}:`, error);
  } finally {
    liveCopies.delete(dir);
    keptCopies.delete(dir);
    releaseFolder(dir);
  }
}

/** Whether a folder is where a run's profile copy goes (`<base>/<project>/<profile>/<slot>`, not a saved copy) */
export function isBrowserProfileCopyPath(dir: string): boolean {
  const bases = new Set([...runtimeCopiesBases(), nativeCopiesBase()]);
  for (const base of bases) {
    const parts = path.relative(base, dir).split(/[\\/]/);
    if (parts.length === 3 && parts.every((part) => part && part !== '..' && part !== '.') && parts[0] !== SAVED_FOLDER) return true;
  }
  return false;
}

/**
 * Keep a chat browser's copy left by a crash for its chat (chat-browser-restore.ts): this process
 * takes it over (owner file), so neither its sweeps nor another Workbench's remove it, and quitting
 * leaves it. False when it isn't there or another running Workbench holds it
 */
export async function keepBrowserProfileCopy(dir: string): Promise<boolean> {
  try {
    if (!(await stat(dir)).isDirectory()) return false;
    if ((await folderClaim(dir)) === 'live') return false;
    await writeOwner(dir);
  } catch {
    return false;
  }
  keptCopies.add(dir);
  claimFolder(dir);
  return true;
}

/** A kept copy is used by a run again (its chat's browser opened): removed on quit like any run's */
export function useKeptBrowserProfileCopy(dir: string): void {
  keptCopies.delete(dir);
  liveCopies.add(dir);
  claimFolder(dir);
}
