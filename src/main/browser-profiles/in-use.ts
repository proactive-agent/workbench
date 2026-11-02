/**
 * Whether the browser chosen for the Puppeteer connector is open with its profile. Runs copy the
 * profile, which an open browser keeps locked and half written, so the connector waits until it
 * is closed (mcp-availability.ts).
 *
 * Read from the lock the browser holds, not from the process list: only the chosen profile
 * counts, never Puppeteer's own browsers (they run on copies). On Linux and macOS the lock is a
 * link naming the browser's process (Firefox's `lock` -> `127.0.1.1:+<pid>`, Chromium's
 * `SingletonLock` -> `<host>-<pid>`), checked to be alive since a crash leaves it behind: a
 * Chromium lock from another host, a process of another user, or a process that isn't a browser
 * (by its name: /proc on Linux, `ps` on macOS) reads as closed. On Windows the browser keeps the lock file open
 * (`parent.lock`, `lockfile`), so it can't be opened. A Chromium browser that keeps running
 * without windows (Edge's Startup boost, Chrome's "Continue running background apps") holds it
 * too, and its profile's files with it, so it counts as open: the tip says to quit it from the
 * system tray or turn that setting off.
 * macOS Firefox keeps only `.parentlock` (an fcntl lock Node can't test), so it reads as closed.
 */

import { execFile } from 'child_process';
import { open, readFile, readlink } from 'fs/promises';
import { hostname } from 'os';
import path from 'path';
import { promisify } from 'util';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { isLinux, isMacOS, isWindows } from '../platform';
import { isWslUncPath } from '../platform/wsl-paths';

/** Process names (Linux `comm`, at most 15 characters) of the browsers that write these locks */
const BROWSER_PROCESS = /chrom|msedge|brave|vivaldi|opera|yandex|firefox|gecko|librewolf|waterfox|floorp/i;

const execFileAsync = promisify(execFile);
/** How long `ps` may take on macOS */
const PS_TIMEOUT_MS = 3000;

/**
 * The process's name: `comm` from /proc on Linux, `ps -o comm=` on macOS (the executable's path,
 * cut to its file name and to Linux's 15 characters so one check fits both), or null when it can't
 * be read
 */
async function processName(pid: number): Promise<string | null> {
  if (isLinux()) {
    try {
      return (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim();
    } catch {
      return null;
    }
  }
  if (isMacOS()) {
    try {
      // A system tool, not a detected one: /bin/ps on every macOS, run natively
      const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: PS_TIMEOUT_MS });
      const name = path.basename(stdout.trim()).slice(0, 15);
      return name || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether the browser that wrote a lock still runs as this process. After a crash and a reboot
 * its id can belong to anything, so a name that isn't a browser's doesn't count (Linux and macOS
 * read the name), and without a name neither does another user's process (the user's browser runs
 * as the user).
 *
 * The process's start isn't compared with the lock's time: the lock's mtime is wall-clock time,
 * so a clock step (NTP, a VM resumed) between writing it and now moves it against any start time,
 * and an open browser would read as closed, letting a run copy a half-written profile. A pid
 * reused by another browser after a crash reads as open instead, which only makes the connector
 * wait (the browser fixes its stale lock when it next starts)
 */
async function browserRunning(pid: number, executablePath: string): Promise<boolean> {
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
  return BROWSER_PROCESS.test(name) || (executable !== '' && name === executable);
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
    // A WSL browser (stored with its Linux path, or a WSL UNC path): its process can't be seen from
    // Windows. Other UNC paths are network shares
    if (dir.startsWith('/') || isWslUncPath(dir)) return false;
    return fileHeld(path.join(dir, firefox ? 'parent.lock' : 'lockfile'));
  }
  if (firefox) {
    const link = path.join(dir, 'lock');
    const target = await readLock(link);
    const pid = target === null ? undefined : parseFirefoxLock(target);
    return pid !== undefined && browserRunning(pid, choice.executablePath);
  }
  const link = path.join(dir, 'SingletonLock');
  const target = await readLock(link);
  const lock = target === null ? undefined : parseChromiumLock(target);
  // Another host's lock (a shared home folder, or the host was renamed): its process isn't here to check
  return lock !== undefined && lock.host === hostname() && browserRunning(lock.pid, choice.executablePath);
}
