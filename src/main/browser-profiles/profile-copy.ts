/**
 * Copies of browser profiles for Puppeteer runs
 * =============================================
 *
 * A run never drives the user's real profile folder: Chrome 136+ refuses remote debugging on its
 * default user data folder, and a browser that is open holds a lock on it. Each run gets a copy in
 * `<project>/.workbench/browser-profiles/<profile>/<slot>` (a slot per task, one for Claude chat),
 * so parallel runs never share a folder. Caches and lock files are left out; files a running
 * browser keeps locked (Windows) are skipped, so closing the browser first copies every sign-in.
 *
 * A Chromium copy keeps the user data folder's layout (`Local State`, which holds the cookie key
 * on Windows, plus the profile's folder), so the same browser can still decrypt its cookies. With
 * the project on a Windows drive in WSL the copy goes through /mnt and is slower.
 */

import path from 'path';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { toHostPath } from '../platform/shell-runtime';
import { appLog } from '../app-logger';

/** Folders and files (relative to the profile, with `/`) a copy leaves out: caches and locks */
const SKIPPED_PATHS = new Set([
  // Chromium
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache',
  'GraphiteDawnCache', 'ShaderCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache',
  'Extensions', 'optimization_guide_model_store',
  // Firefox
  'cache2', 'startupCache', 'thumbnails', 'crashes', 'minidumps', 'parent.lock', '.parentlock', 'lock',
]);
/** File names left out wherever they are */
const SKIPPED_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
/** Errors from files a running browser holds, or that vanished during the copy */
const SKIPPABLE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);

/** A folder name for a profile id (`chrome:Profile 1` -> `chrome_Profile_1`) */
function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** Where a slot's copy of a profile lives (host path) */
export function browserProfileCopyDir(projectPath: string, choice: PuppeteerBrowserChoice, slot: string): string {
  return path.join(projectPath, '.workbench', 'browser-profiles', slug(choice.id), slug(slot));
}

/** Copy a folder, leaving out SKIPPED_* and files that can't be read; returns how many were skipped */
async function copyTree(source: string, target: string, relative = ''): Promise<number> {
  await mkdir(target, { recursive: true });
  let skipped = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (SKIPPED_PATHS.has(rel) || SKIPPED_NAMES.has(entry.name)) continue;
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

/**
 * Make a fresh copy of the chosen profile for a run and return its folder (host path), or null
 * when the profile is gone or the browser is Puppeteer's own download (the run then uses the
 * browser with a new profile)
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
  await rm(target, { recursive: true, force: true });
  let skipped: number;
  if (choice.engine === 'chromium') {
    const profileDirectory = choice.profileDirectory ?? 'Default';
    skipped = await copyTree(source, path.join(target, profileDirectory));
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
  if (skipped > 0) {
    appLog.warn(`[BrowserProfiles] ${skipped} file(s) of ${choice.id} could not be copied (is the browser open?)`);
  }
  return target;
}

/**
 * Remove a profile's copies whose slot starts with `prefix`, except `keep` (copies left by earlier
 * runs of a task that never cleaned up, such as after a crash). Best effort
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
      .map((name) => removeBrowserProfileCopy(path.join(parent, name)))
  );
}

/** Remove a run's copy (best effort: a browser that is still closing may hold files) */
export async function removeBrowserProfileCopy(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (error) {
    appLog.warn(`[BrowserProfiles] Could not remove ${dir}:`, error);
  }
}
