/**
 * Copies of browser profiles for Puppeteer runs
 * =============================================
 *
 * A run never drives the user's real profile folder: Chrome 136+ refuses remote debugging on its
 * default user data folder, and a browser that is open holds a lock on it. Each run gets a copy in
 * the app's own data folder, `<userData>/browser-profiles/<project>/<profile>/<slot>` (a slot per
 * task run or chat turn), so parallel runs never share a folder. Copies stay out of the project:
 * they hold cookies and sign-ins, and the project is what Claude Code sessions (the read-only
 * Claude chat too) can read. In WSL the browsers are Linux ones, so the copies live in the
 * distribution's home (`~/.cache/workbench/browser-profiles`), where the browser reads them
 * natively. Caches, locks, the session to restore and Firefox's Sync account are left out; files
 * a running browser keeps locked (Windows) are skipped, so closing the browser first copies every
 * sign-in. The folders are private (0700) where the filesystem keeps modes.
 *
 * Each copy names the Workbench process that made it (OWNER_FILE: pid, plus the process's start
 * on Linux), since two Workbench processes can share the data folder (`npm run dev` next to the
 * installed app). Copies no live run uses are removed: at startup (all of them, except copies
 * another running Workbench owns), on quit (those of runs still going, such as chat turns), at
 * once when they are another profile's (an earlier choice), and after a day otherwise; a copy
 * whose owner is another live Workbench process is never swept.
 *
 * A Chromium copy keeps the user data folder's layout (`Local State`, which holds the cookie key
 * on Windows, plus the profile's folder), so the same browser can still decrypt its cookies.
 */

import path from 'path';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { app } from 'electron';
import { chmod, copyFile, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'fs/promises';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { getWslInfo, toHostPath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { isLinux, isWindows } from '../platform';
import { windowsPathKey } from '../platform/wsl-paths';
import { appLog } from '../app-logger';

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
const SKIPPED_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
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
/** The file in each copy naming the Workbench process that made it (browsers ignore it) */
const OWNER_FILE = '.workbench-copy-owner.json';
/** A copy without an owner file this recent may be one another process is setting up: kept */
const UNOWNED_GRACE_MS = 10 * 60 * 1000;
/**
 * Where an owner can't be told apart from a process that later took its id (off Linux, or another
 * host sharing the folder), its claim on a copy lasts this long; no run takes a week
 */
const UNVERIFIED_OWNER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Copies made or being made for runs of this app session (host paths), never swept */
const liveCopies = new Set<string>();
const lastSweep = new Map<string, number>();

/** Who made a copy: the process id, the host, and on Linux the boot and the process's start (clock ticks since boot) */
interface CopyOwner {
  pid: number;
  host: string;
  boot?: string;
  start?: string;
}

/** The boot id and a process's start time from /proc (Linux; both empty elsewhere or when unreadable) */
async function linuxProcessIdentity(pid: number): Promise<Pick<CopyOwner, 'boot' | 'start'>> {
  if (!isLinux()) return {};
  const [boot, start] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf-8').then((text) => text.trim() || undefined, () => undefined),
    // Fields after `(comm)`, which may hold spaces and parentheses: state is field 3, starttime 22
    readFile(`/proc/${pid}/stat`, 'utf-8').then((text) => text.slice(text.lastIndexOf(')') + 2).split(' ')[19] || undefined, () => undefined),
  ]);
  return { boot, start };
}

let thisProcess: Promise<CopyOwner> | undefined;
function thisOwner(): Promise<CopyOwner> {
  thisProcess ??= linuxProcessIdentity(process.pid).then((identity) => ({ pid: process.pid, host: hostname(), ...identity }));
  return thisProcess;
}

/**
 * Whether another Workbench process that still runs owns this copy, so a sweep must leave it. A
 * copy without an owner file (an earlier version's, or one being set up) counts as owned while it
 * is recent. This process's own copies don't count: liveCopies says which of them are in use
 */
async function ownedByAnotherProcess(dir: string): Promise<boolean> {
  let owner: CopyOwner;
  let claimedMs: number;
  try {
    const file = path.join(dir, OWNER_FILE);
    const [text, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
    owner = JSON.parse(text) as CopyOwner;
    claimedMs = info.mtimeMs;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== 'string') throw new Error('bad owner');
  } catch {
    try {
      return Date.now() - (await stat(dir)).mtimeMs < UNOWNED_GRACE_MS;
    } catch {
      return false;
    }
  }
  const self = await thisOwner();
  if (owner.pid === self.pid && owner.host === self.host && owner.boot === self.boot && owner.start === self.start) return false;
  const recentClaim = Date.now() - claimedMs < UNVERIFIED_OWNER_AGE_MS;
  // Another host's process (a shared home folder) can't be checked from here
  if (owner.host !== self.host) return recentClaim;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM: it runs, as another user
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (owner.boot !== undefined && owner.start !== undefined && isLinux()) {
    // The same boot and start time: the owner itself, not a process that took its id
    const now = await linuxProcessIdentity(owner.pid);
    return now.boot === owner.boot && now.start === owner.start;
  }
  return recentClaim;
}

/** Mark a copy as this process's */
async function writeOwner(dir: string): Promise<void> {
  await writeFile(path.join(dir, OWNER_FILE), JSON.stringify(await thisOwner()), { mode: 0o600 });
}

/** A folder name for a profile id (`chrome:Profile 1` -> `chrome_Profile_1`) */
function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** The app's own folder for copies outside WSL */
function nativeCopiesBase(): string {
  return path.join(app.getPath('userData'), 'browser-profiles');
}

/** Where every project's copies live (host path): the distribution's home in WSL, where its browsers run */
function copiesBase(): string {
  const wsl = getWslInfo();
  if (wsl?.home) return toHostPath(path.posix.join(wsl.home, '.cache', 'workbench', 'browser-profiles'));
  return nativeCopiesBase();
}

/** A project's folder among the copies: its name plus a hash of its path */
function projectFolder(projectPath: string): string {
  const key = isWindows() ? windowsPathKey(projectPath) : path.resolve(projectPath);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${slug(path.basename(projectPath)).slice(0, 40) || 'project'}-${hash}`;
}

/** Where a project's copies live (host path) */
export function browserProfileCopiesRoot(projectPath: string): string {
  return path.join(copiesBase(), projectFolder(projectPath));
}

/** Where earlier versions kept a project's copies, inside the project */
function legacyCopiesRoot(projectPath: string): string {
  return path.join(projectPath, '.workbench', 'browser-profiles');
}

/** Where a slot's copy of a profile lives (host path) */
export function browserProfileCopyDir(projectPath: string, choice: PuppeteerBrowserChoice, slot: string): string {
  return path.join(browserProfileCopiesRoot(projectPath), slug(choice.id), slug(slot));
}

/** Make a folder private; best effort where the filesystem can't hold modes */
async function makePrivate(dir: string): Promise<void> {
  try {
    await chmod(dir, PRIVATE_MODE);
  } catch (error) {
    if (!MODELESS_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

/** Copy a folder, leaving out SKIPPED_* and files that can't be read; returns how many were skipped */
async function copyTree(source: string, target: string, relative = ''): Promise<number> {
  await mkdir(target, { recursive: true, mode: PRIVATE_MODE });
  let skipped = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (SKIPPED_PATHS.has(rel) || SKIPPED_NAMES.has(entry.name)) continue;
    if (entry.isDirectory() && SKIPPED_FOLDERS.has(entry.name)) continue;
    // Symlinks are locks (Firefox's `lock`, Chromium's Singleton*) or point outside the profile
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) skipped += await copyTree(from, to, rel);
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
 * Make a fresh copy of the chosen profile for a run and return its folder (host path), or null
 * when the profile is gone or the browser is Puppeteer's own download (the run then uses the
 * browser with a new profile). A copy that fails (a full disk) is removed before the error is
 * thrown. The copy counts as live until removeBrowserProfileCopy
 */
export async function prepareBrowserProfileCopy(projectPath: string, choice: PuppeteerBrowserChoice, slot: string): Promise<string | null> {
  // Puppeteer's own download has no profile: it starts the browser with a new one
  // Not awaited: the run doesn't need it. Without a profile to copy, no copy is kept
  if (choice.managed) {
    void removeOldBrowserProfileCopies(projectPath, { current: null });
    return null;
  }
  const source = toHostPath(choice.profilePath);
  try {
    if (!(await stat(source)).isDirectory()) throw new Error('not a folder');
  } catch {
    appLog.warn(`[BrowserProfiles] ${choice.id} not found at ${source}; Puppeteer uses the browser with a new profile`);
    void removeOldBrowserProfileCopies(projectPath, { current: null });
    return null;
  }
  const target = browserProfileCopyDir(projectPath, choice, slot);
  liveCopies.add(target);
  void removeOldBrowserProfileCopies(projectPath, { current: choice });
  let skipped: number;
  try {
    await rm(target, { recursive: true, force: true });
    // The slot first (with its parents), so a sweep never finds its parents empty; then the owner
    await mkdir(target, { recursive: true, mode: PRIVATE_MODE });
    await writeOwner(target);
    // Private all the way down, also for folders made before copies were private
    const projectRoot = browserProfileCopiesRoot(projectPath);
    await makePrivate(path.dirname(projectRoot));
    await makePrivate(projectRoot);
    await makePrivate(path.dirname(target));
    await makePrivate(target);
    if (choice.engine === 'chromium') {
      const profileDirectory = choice.profileDirectory ?? 'Default';
      skipped = await copyTree(source, path.join(target, profileDirectory));
      await disableSessionRestore(path.join(target, profileDirectory, 'Preferences'));
      try {
        await copyFile(path.join(toHostPath(choice.userDataDir), 'Local State'), path.join(target, 'Local State'));
      } catch {
        skipped++;
      }
      // No first-run pages in the copy
      await writeFile(path.join(target, 'First Run'), '');
    } else {
      skipped = await copyTree(source, target);
    }
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

/** Whether a sweep may remove this copy: no run of this process uses it and no other running Workbench owns it */
async function removable(dir: string): Promise<boolean> {
  return !liveCopies.has(dir) && !(await ownedByAnotherProcess(dir));
}

/**
 * Remove a profile's copies whose slot starts with `prefix`, except `keep`, live runs' copies and
 * other running Workbench processes' (copies left by earlier runs of a task that never cleaned up,
 * such as after a crash). Best effort
 */
export async function removeStaleBrowserProfileCopies(
  projectPath: string,
  choice: PuppeteerBrowserChoice,
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
   * The profile runs use now: other profiles' copies (an earlier choice) go at any age. null: runs
   * use no profile (Puppeteer's own browser, or the profile is gone), so every copy goes. Unset:
   * every copy is kept for a day
   */
  current?: PuppeteerBrowserChoice | null;
  /** Every copy no live run uses goes, whatever its age (at startup, before anything runs) */
  all?: boolean;
}

/**
 * Remove the copies under `root` (`<root>/<profile>/<slot>`) that no live run uses and no other
 * running Workbench owns: older than a day, or as `options` says
 */
async function sweepCopies(root: string, options: BrowserProfileSweepOptions): Promise<void> {
  const now = Date.now();
  const { current } = options;
  let profiles: string[];
  try {
    profiles = await readdir(root);
  } catch {
    return;
  }
  const currentProfile = current ? slug(current.id) : undefined;
  for (const profile of profiles) {
    const anyAge = options.all === true || current === null || (currentProfile !== undefined && profile !== currentProfile);
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
 * day, or as `options` says (left by a crash, a deleted task or an earlier browser choice). At most
 * once an hour per project and current profile unless `force`. Best effort
 */
export async function removeOldBrowserProfileCopies(projectPath: string, options: BrowserProfileSweepOptions = {}): Promise<void> {
  const now = Date.now();
  const { current } = options;
  // A changed choice is looked at again at once
  const sweepKey = `${projectPath}\0${current === undefined ? '' : current === null ? '-' : slug(current.id)}`;
  if (!options.force && now - (lastSweep.get(sweepKey) ?? 0) < SWEEP_INTERVAL_MS) return;
  lastSweep.set(sweepKey, now);
  await sweepCopies(browserProfileCopiesRoot(projectPath), options);
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
    // Both the current place and, in WSL, the native one (a session from before a runtime switch)
    bases.add(copiesBase());
    bases.add(nativeCopiesBase());
  } catch (error) {
    appLog.warn('[BrowserProfiles] Could not find the folder of profile copies:', error);
  }
  const roots: string[] = [];
  for (const base of bases) {
    try {
      roots.push(...(await readdir(base)).map((name) => path.join(base, name)));
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
  }
}
