/**
 * Copies of browser profiles for Puppeteer runs
 * =============================================
 *
 * A run never drives the user's real profile folder: Chrome 136+ refuses remote debugging on its
 * default user data folder, and a browser that is open holds a lock on it. Each run gets a copy in
 * `<project>/.workbench/browser-profiles/<profile>/<slot>` (a slot per task run or chat turn), so
 * parallel runs never share a folder. Caches, locks, the session to restore and Firefox's Sync
 * account are left out; files a running browser keeps locked (Windows) are skipped, so closing
 * the browser first copies every sign-in. The copies hold cookies, so the folders are private
 * (0700) and copies no live run uses are removed after a day.
 *
 * A Chromium copy keeps the user data folder's layout (`Local State`, which holds the cookie key
 * on Windows, plus the profile's folder), so the same browser can still decrypt its cookies. With
 * the project on a Windows drive in WSL the copy goes through /mnt and is slower.
 */

import path from 'path';
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { toHostPath } from '../platform/shell-runtime';
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
/** A copy no live run uses is removed once it is this old (a crash, or another choice's copy) */
const STALE_COPY_AGE_MS = 24 * 60 * 60 * 1000;
/** How often a project's old copies are looked for */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Copies made or being made for runs of this app session (host paths), never swept */
const liveCopies = new Set<string>();
const lastSweep = new Map<string, number>();

/** A folder name for a profile id (`chrome:Profile 1` -> `chrome_Profile_1`) */
function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function copiesRoot(projectPath: string): string {
  return path.join(projectPath, '.workbench', 'browser-profiles');
}

/** Where a slot's copy of a profile lives (host path) */
export function browserProfileCopyDir(projectPath: string, choice: PuppeteerBrowserChoice, slot: string): string {
  return path.join(copiesRoot(projectPath), slug(choice.id), slug(slot));
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
  if (choice.managed) return null;
  const source = toHostPath(choice.profilePath);
  try {
    if (!(await stat(source)).isDirectory()) return null;
  } catch {
    appLog.warn(`[BrowserProfiles] ${choice.id} not found at ${source}; Puppeteer uses the browser with a new profile`);
    return null;
  }
  const target = browserProfileCopyDir(projectPath, choice, slot);
  liveCopies.add(target);
  // Not awaited: the run doesn't need it
  void removeOldBrowserProfileCopies(projectPath);
  let skipped: number;
  try {
    await rm(target, { recursive: true, force: true });
    // Private all the way down, also for folders made before copies were private
    const root = copiesRoot(projectPath);
    await mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_MODE });
    await chmod(root, PRIVATE_MODE);
    await chmod(path.dirname(target), PRIVATE_MODE);
    if (choice.engine === 'chromium') {
      const profileDirectory = choice.profileDirectory ?? 'Default';
      await mkdir(target, { mode: PRIVATE_MODE });
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

/**
 * Remove a profile's copies whose slot starts with `prefix`, except `keep` and live runs' copies
 * (copies left by earlier runs of a task that never cleaned up, such as after a crash). Best effort
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
      .filter((name) => name !== keepName && name.startsWith(slugPrefix) && !liveCopies.has(path.join(parent, name)))
      .map((name) => removeBrowserProfileCopy(path.join(parent, name)))
  );
}

/**
 * Remove a project's copies, of any profile, that no live run uses and that are older than a day:
 * left by a crash, a deleted task or an earlier browser choice. At most once an hour per project
 * unless `force`. Best effort
 */
export async function removeOldBrowserProfileCopies(projectPath: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastSweep.get(projectPath) ?? 0) < SWEEP_INTERVAL_MS) return;
  lastSweep.set(projectPath, now);
  const root = copiesRoot(projectPath);
  let profiles: string[];
  try {
    profiles = await readdir(root);
  } catch {
    return;
  }
  for (const profile of profiles) {
    let slots: string[];
    try {
      slots = await readdir(path.join(root, profile));
    } catch {
      continue;
    }
    for (const slot of slots) {
      const dir = path.join(root, profile, slot);
      if (liveCopies.has(dir)) continue;
      try {
        if (now - (await stat(dir)).mtimeMs < STALE_COPY_AGE_MS) continue;
      } catch {
        continue;
      }
      // A run may have started in this slot while it was being checked
      if (!liveCopies.has(dir)) await removeBrowserProfileCopy(dir);
    }
  }
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
