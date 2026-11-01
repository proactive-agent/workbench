/**
 * Whether the browser chosen for the Puppeteer connector is open with its profile. Runs copy the
 * profile, which an open browser keeps locked and half written, so the connector waits until it
 * is closed (mcp-availability.ts).
 *
 * Read from the lock the browser holds, not from the process list: only the chosen profile
 * counts, never Puppeteer's own browsers (they run on copies). On Linux and macOS the lock is a
 * link naming the browser's process (Firefox's `lock` -> `127.0.1.1:+<pid>`, Chromium's
 * `SingletonLock` -> `<host>-<pid>`), checked to be alive since a crash leaves it behind. On
 * Windows the browser keeps the lock file open (`parent.lock`, `lockfile`), so it can't be opened.
 * macOS Firefox keeps only `.parentlock` (an fcntl lock Node can't test), so it reads as closed.
 */

import { open, readlink } from 'fs/promises';
import path from 'path';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { isWindows } from '../platform';

/** Whether a process with this id is running */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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

/** A lock link naming a live process (its id at the end of the link) */
async function linkHeld(link: string, pidPattern: RegExp): Promise<boolean> {
  try {
    const pid = Number(pidPattern.exec(await readlink(link))?.[1]);
    return pid > 0 && processAlive(pid);
  } catch {
    // No lock: the browser is closed
    return false;
  }
}

export async function isBrowserProfileInUse(choice: PuppeteerBrowserChoice): Promise<boolean> {
  // Puppeteer's own browsers start on a new profile each time
  if (choice.managed) return false;
  const firefox = choice.engine === 'firefox';
  // Firefox locks the profile; Chromium the user data folder, shared by its profiles
  const dir = firefox ? choice.profilePath : choice.userDataDir;
  if (isWindows()) {
    // A WSL path: its browser's process can't be seen from Windows
    if (dir.startsWith('\\\\')) return false;
    return fileHeld(path.join(dir, firefox ? 'parent.lock' : 'lockfile'));
  }
  return firefox
    ? linkHeld(path.join(dir, 'lock'), /\+(\d+)$/)
    : linkHeld(path.join(dir, 'SingletonLock'), /-(\d+)$/);
}
