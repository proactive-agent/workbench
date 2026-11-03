/**
 * Workbench's folders in the system temp folder
 * =============================================
 *
 * Some work keeps files in a folder of its own in the system temp folder, removed when it ends:
 * a task phase's support files (`workbench-task-`), a chat turn's (`workbench-insights-`), a
 * chat's browser (`workbench-chat-browser-`, its workspace; for Playwright's own browsers also
 * the profile with its sign-ins), the browser drawer's bridge script (`workbench-browser-bridge-`)
 * and a Playwright availability check's output (`workbench-mcp-probe-`). Each is made with an
 * owner file naming this Workbench process (folder-owner.ts), and a task phase's or chat turn's
 * also names the Claude Code process that uses it (RUN_FILE), which may outlive a crash.
 *
 * A crash (or a kill) leaves them behind. At startup, removeLeftoverTempFolders removes those whose
 * owner and run no longer run, in the background and one at a time; another running Workbench's
 * folders, and folders without an owner file younger than UNVERIFIED_OWNER_AGE_MS (made by an
 * older version, or being set up), stay. A chat browser's folder is looked at first by
 * chat-browser-restore.ts, which keeps it for its chat to open again.
 *
 * Natively only: in WSL mode these folders are still made on the Windows side (os.tmpdir()), so
 * they are covered too; nothing is made in the distribution's /tmp.
 */

import os from 'os';
import path from 'path';
import { mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { appLog } from './app-logger';
import {
  claimFolder,
  folderClaim,
  processIdentity,
  processRuns,
  readProcessFile,
  releaseFolder,
  UNVERIFIED_OWNER_AGE_MS,
  writeOwner,
} from './folder-owner';

/** The temp folders Workbench makes, by the prefix of their names */
export const TEMP_FOLDER_PREFIXES = {
  task: 'workbench-task-',
  chatTurn: 'workbench-insights-',
  chatBrowser: 'workbench-chat-browser-',
  browserBridge: 'workbench-browser-bridge-',
  mcpProbe: 'workbench-mcp-probe-',
} as const;
type TempFolderPrefix = (typeof TEMP_FOLDER_PREFIXES)[keyof typeof TEMP_FOLDER_PREFIXES];

/** The file naming the Claude Code process that uses a folder */
const RUN_FILE = '.workbench-run-process.json';

/** Make a temp folder of this process (mkdtemp, with its owner file) */
export async function makeTempFolder(prefix: TempFolderPrefix, parent = os.tmpdir()): Promise<string> {
  const dir = await mkdtemp(path.join(parent, prefix));
  try {
    await writeOwner(dir);
    claimFolder(dir);
  } catch (error) {
    // Without its owner file the folder is still removed by its owner; a crash leaves it to the age rule
    appLog.warn(`[TempFolders] Could not mark ${dir} as this process's:`, error);
  }
  return dir;
}

/** Remove a temp folder of this process (best effort) */
export async function removeTempFolder(dir: string): Promise<void> {
  releaseFolder(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
}

/** Record the Claude Code process that uses a temp folder: it stays while that process runs */
export async function noteTempFolderRun(dir: string, pid: number | undefined): Promise<void> {
  if (!pid) return;
  await writeFile(path.join(dir, RUN_FILE), JSON.stringify(await processIdentity(pid)), { mode: 0o600 }).catch(() => undefined);
}

/** Whether a leftover temp folder may be removed: no running Workbench or run holds it */
async function tempFolderRemovable(dir: string): Promise<boolean> {
  if ((await folderClaim(dir, UNVERIFIED_OWNER_AGE_MS)) !== 'gone') return false;
  const run = await readProcessFile(path.join(dir, RUN_FILE));
  return !run || !(await processRuns(run.identity, run.claimedMs));
}

interface TempFolderSweepOptions {
  /** The temp folder (tests) */
  parent?: string;
  /** Prefixes not looked at (the chat browsers' folders, which chat-browser-restore.ts handles) */
  skip?: readonly string[];
}

/**
 * At startup: remove the temp folders left by Workbench processes that no longer run (and whose
 * run doesn't either). Not awaited by startup; one folder at a time; best effort. Returns the
 * folders removed
 */
export async function removeLeftoverTempFolders(options: TempFolderSweepOptions = {}): Promise<string[]> {
  const parent = options.parent ?? os.tmpdir();
  const prefixes = Object.values(TEMP_FOLDER_PREFIXES).filter((prefix) => !options.skip?.includes(prefix));
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const dir = path.join(parent, name);
    try {
      if (!(await stat(dir)).isDirectory() || !(await tempFolderRemovable(dir))) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(dir);
    } catch (error) {
      appLog.warn(`[TempFolders] Could not remove ${dir}:`, error);
    }
  }
  if (removed.length > 0) appLog.info(`[TempFolders] Removed ${removed.length} folder(s) left by an earlier run`);
  return removed;
}
