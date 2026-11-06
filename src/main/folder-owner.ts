/**
 * Folder owners
 * =============
 *
 * Folders Workbench leaves on disk while it works (browser profile copies, its folders in the
 * system temp folder) name the Workbench process that made them in an owner file (OWNER_FILE: pid
 * and host, plus on Linux the boot and the process's start), since two Workbench processes can
 * share them (`npm run dev` next to the installed app). Cleanups leave a folder whose owner still
 * runs. Where a process can't be told from one that later took its id (off Linux, or another host
 * sharing the folder), the owner refreshes the file's time while it uses the folder (claimFolder),
 * and a claim not refreshed for UNVERIFIED_OWNER_AGE_MS has ended.
 *
 * The same identity tells whether another process (a Claude Code run that may outlive a crash)
 * still runs (processIdentity / processRuns).
 */

import path from 'path';
import { hostname } from 'os';
import { readFile, stat, utimes, writeFile } from 'fs/promises';
import { isLinux } from './platform';

/** The file in each owned folder naming the Workbench process that made it (browsers ignore it) */
export const OWNER_FILE = '.workbench-copy-owner.json';
/** A folder without an owner file this recent may be one another process is setting up: kept */
const UNOWNED_GRACE_MS = 10 * 60 * 1000;
/** How often the owner refreshes the time of its claimed folders' owner files */
const OWNER_HEARTBEAT_MS = 10 * 60 * 1000;
/**
 * Where an owner can't be told apart from a process that later took its id (off Linux, or another
 * host sharing the folder), its claim on a folder ends when not refreshed for this long
 */
export const UNVERIFIED_OWNER_AGE_MS = 60 * 60 * 1000;

/** A process: its id, the host, and on Linux the boot and the process's start (clock ticks since boot) */
interface ProcessIdentity {
  pid: number;
  host: string;
  boot?: string;
  start?: string;
}

/** Who holds a folder: this process, another one that still runs, or no one */
type FolderClaim = 'self' | 'live' | 'gone';

/** The boot id and a process's start time from /proc (Linux; both empty elsewhere or when unreadable) */
async function linuxProcessIdentity(pid: number): Promise<Pick<ProcessIdentity, 'boot' | 'start'>> {
  if (!isLinux()) return {};
  const [boot, start] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf-8').then((text) => text.trim() || undefined, () => undefined),
    // Fields after `(comm)`, which may hold spaces and parentheses: state is field 3, starttime 22
    readFile(`/proc/${pid}/stat`, 'utf-8').then((text) => text.slice(text.lastIndexOf(')') + 2).split(' ')[19] || undefined, () => undefined),
  ]);
  return { boot, start };
}

/** A process's identity, to tell later whether it still runs */
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  return { pid, host: hostname(), ...(await linuxProcessIdentity(pid)) };
}

let thisProcess: Promise<ProcessIdentity> | undefined;
/** This Workbench process */
export function thisOwner(): Promise<ProcessIdentity> {
  thisProcess ??= processIdentity(process.pid);
  return thisProcess;
}

function isIdentity(value: unknown): value is ProcessIdentity {
  const owner = value as ProcessIdentity | null;
  return !!owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string';
}

/**
 * Whether a process still runs: on this host, by its id and (on Linux) its start, so a process
 * that later took the id doesn't count; `claimedMs` (when its record was last refreshed) decides
 * where that can't be checked
 */
export async function processRuns(identity: ProcessIdentity, claimedMs: number): Promise<boolean> {
  const recentClaim = Date.now() - claimedMs < UNVERIFIED_OWNER_AGE_MS;
  // Another host's process (a shared home folder) can't be checked from here
  if (identity.host !== hostname()) return recentClaim;
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    // EPERM: it runs, as another user
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (identity.boot !== undefined && identity.start !== undefined && isLinux()) {
    // The same boot and start time: the process itself, not one that took its id
    const now = await linuxProcessIdentity(identity.pid);
    return now.boot === identity.boot && now.start === identity.start;
  }
  return recentClaim;
}

/** A process recorded in a JSON file (the file's time: when it was last refreshed), or null */
export async function readProcessFile(file: string): Promise<{ identity: ProcessIdentity; claimedMs: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
    const identity = JSON.parse(text) as unknown;
    return isIdentity(identity) ? { identity, claimedMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Who holds a folder. One without an owner file (an earlier version's, or one being set up) counts
 * as another live process's while it is more recent than `unownedGraceMs`
 */
export async function folderClaim(dir: string, unownedGraceMs = UNOWNED_GRACE_MS): Promise<FolderClaim> {
  const owner = await readProcessFile(path.join(dir, OWNER_FILE));
  if (!owner) {
    try {
      return Date.now() - (await stat(dir)).mtimeMs < unownedGraceMs ? 'live' : 'gone';
    } catch {
      return 'gone';
    }
  }
  const self = await thisOwner();
  const { identity } = owner;
  if (identity.pid === self.pid && identity.host === self.host && identity.boot === self.boot && identity.start === self.start) return 'self';
  return (await processRuns(identity, owner.claimedMs)) ? 'live' : 'gone';
}

/** Mark a folder as this process's */
export async function writeOwner(dir: string): Promise<void> {
  await writeFile(path.join(dir, OWNER_FILE), JSON.stringify(await thisOwner()), { mode: 0o600 });
}

/** Folders this process holds whose owner file's time the heartbeat refreshes */
const claimed = new Set<string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Keep refreshing a folder's owner file while this process uses it (see UNVERIFIED_OWNER_AGE_MS) */
export function claimFolder(dir: string): void {
  claimed.add(dir);
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const now = new Date();
    for (const folder of claimed) void utimes(path.join(folder, OWNER_FILE), now, now).catch(() => undefined);
  }, OWNER_HEARTBEAT_MS);
  heartbeat.unref?.();
}

/** Stop refreshing a folder's owner file (it was removed, or is no longer used) */
export function releaseFolder(dir: string): void {
  claimed.delete(dir);
  if (claimed.size > 0 || !heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}
