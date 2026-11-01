/**
 * Whether the browser chosen for the Puppeteer connector is open with its profile. Runs copy the
 * profile, which an open browser keeps locked and half written, so the connector waits until it
 * is closed (mcp-availability.ts).
 *
 * Read from the lock the browser holds, not from the process list: only the chosen profile
 * counts, never Puppeteer's own browsers (they run on copies). On Linux and macOS the lock is a
 * link naming the browser's process (Firefox's `lock` -> `127.0.1.1:+<pid>`, Chromium's
 * `SingletonLock` -> `<host>-<pid>`), checked to be alive since a crash leaves it behind: a
 * Chromium lock from another host, a process of another user, or (on Linux, where /proc names it) a
 * process that isn't a browser reads as closed. On Windows the browser keeps the lock file open
 * (`parent.lock`, `lockfile`), so it can't be opened. A Chromium browser that keeps running
 * without windows (Edge's Startup boost, Chrome's "Continue running background apps") holds it
 * too, and its profile's files with it, so it counts as open: the tip says to quit it from the
 * system tray or turn that setting off.
 * macOS Firefox keeps only `.parentlock` (an fcntl lock Node can't test), so it reads as closed.
 */

import { lstat, open, readFile, readlink } from 'fs/promises';
import { hostname } from 'os';
import path from 'path';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { isLinux, isWindows } from '../platform';
import { isWslUncPath } from '../platform/wsl-paths';

/** Process names (Linux `comm`, at most 15 characters) of the browsers that write these locks */
const BROWSER_PROCESS = /chrom|msedge|brave|vivaldi|opera|yandex|firefox|gecko|librewolf|waterfox|floorp/i;

/** The process's name from /proc (Linux), or null when it can't be read */
async function processName(pid: number): Promise<string | null> {
  if (!isLinux()) return null;
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim();
  } catch {
    return null;
  }
}

/** Clock ticks per second of /proc's times (USER_HZ: 100 on every Linux architecture Node runs on) */
const USER_HZ = 100;
/** Slack for the start time read from /proc (whole seconds of boot time, ticks) */
const START_SLACK_MS = 5000;

/** When the process started (epoch ms, Linux), or null when /proc can't tell */
async function processStartMs(pid: number): Promise<number | null> {
  if (!isLinux()) return null;
  try {
    const [stat, procStat] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf-8'), readFile('/proc/stat', 'utf-8')]);
    // Fields after `(comm)`, which may hold spaces and parentheses: state is field 3, starttime 22
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const bootSeconds = Number(/^btime (\d+)$/m.exec(procStat)?.[1]);
    if (!Number.isFinite(ticks) || !(bootSeconds > 0)) return null;
    return bootSeconds * 1000 + (ticks / USER_HZ) * 1000;
  } catch {
    return null;
  }
}

/**
 * Whether the browser that wrote a lock still runs as this process. After a crash and a reboot
 * its id can belong to anything, so a name that isn't a browser's doesn't count, and without a
 * name neither does another user's process (the user's browser runs as the user). The browser
 * writes its lock after it starts, so a process that started after the lock was written (on
 * Linux) took the id of the browser that left it, even when it is a browser too
 */
async function browserRunning(pid: number, executablePath: string, lockWrittenMs?: number): Promise<boolean> {
  let ours: boolean;
  try {
    process.kill(pid, 0);
    ours = true;
  } catch (error) {
    // EPERM: it runs, as another user
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
    ours = false;
  }
  const name = await processName(pid);
  if (name === null) return ours;
  const executable = path.basename(executablePath).slice(0, 15);
  if (!BROWSER_PROCESS.test(name) && !(executable !== '' && name === executable)) return false;
  if (lockWrittenMs === undefined) return true;
  const started = await processStartMs(pid);
  return started === null || started <= lockWrittenMs + START_SLACK_MS;
}

/** When a lock link was written (epoch ms), or undefined when it can't be read */
async function lockWritten(link: string): Promise<number | undefined> {
  try {
    return (await lstat(link)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A Windows lock file the browser holds open */
async function fileHeld(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'r+');
    await handle.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM';
  }
}

/** Firefox's lock link: `<ip>:+<pid>`, or `<ip>:<pid>` where it fell back from fcntl locks (NFS) */
function parseFirefoxLock(target: string): number | undefined {
  const pid = Number(/:\+?(\d+)$/.exec(target)?.[1]);
  return pid > 0 ? pid : undefined;
}

/** Chromium's SingletonLock link: `<host>-<pid>` (the host may contain dashes) */
function parseChromiumLock(target: string): { host: string; pid: number } | undefined {
  const match = /^(.*)-(\d+)$/.exec(target);
  const pid = Number(match?.[2]);
  return match && pid > 0 ? { host: match[1], pid } : undefined;
}

async function readLock(link: string): Promise<string | null> {
  try {
    return await readlink(link);
  } catch {
    // No lock: the browser is closed
    return null;
  }
}

export async function isBrowserProfileInUse(choice: PuppeteerBrowserChoice): Promise<boolean> {
  // Puppeteer's own browsers start on a new profile each time
  if (choice.managed) return false;
  const firefox = choice.engine === 'firefox';
  // Firefox locks the profile; Chromium the user data folder, shared by its profiles
  const dir = firefox ? choice.profilePath : choice.userDataDir;
  if (isWindows()) {
    // A WSL path: its browser's process can't be seen from Windows (other UNC paths are network shares)
    if (isWslUncPath(dir)) return false;
    return fileHeld(path.join(dir, firefox ? 'parent.lock' : 'lockfile'));
  }
  if (firefox) {
    const link = path.join(dir, 'lock');
    const target = await readLock(link);
    const pid = target === null ? undefined : parseFirefoxLock(target);
    return pid !== undefined && browserRunning(pid, choice.executablePath, await lockWritten(link));
  }
  const link = path.join(dir, 'SingletonLock');
  const target = await readLock(link);
  const lock = target === null ? undefined : parseChromiumLock(target);
  // Another host's lock (a shared home folder, or the host was renamed): its process isn't here to check
  return lock !== undefined && lock.host === hostname() && browserRunning(lock.pid, choice.executablePath, await lockWritten(link));
}
