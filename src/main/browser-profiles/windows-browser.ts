/**
 * Windows browsers while tools run in WSL
 * =======================================
 *
 * Playwright runs inside the distribution, so it can't launch a Windows browser itself (it talks to
 * the browsers it launches over pipes, which WSL interop doesn't carry), and the browser's
 * DevTools port on the Windows 127.0.0.1 can't be reached from WSL2 with NAT networking. Instead
 * the Playwright server's command is windows-browser-launcher.cjs, run by the distribution's node:
 * it starts the Windows browser through interop on the run's profile copy (kept on Windows, where
 * the browser reads it natively), relays a local port to its DevTools port through
 * windows-cdp-relay.cjs (run on Windows by Workbench's own executable as Node), and gives the
 * server `--cdp-endpoint`. Nothing is needed on Windows besides the browser: no Node.js, no
 * Playwright. The server binds the browser in the distribution's registry like one it launched,
 * so chat browsers, turns attaching to them and the drawer work as for WSL's own browsers.
 *
 * Chromium browsers only: a Windows Firefox profile runs on a Firefox in WSL instead (its copy
 * keeps its sign-ins, detect.ts). A Chromium copy starts signed out: Chrome and Edge encrypt their
 * cookies with an app-bound key that only opens in the browser's own profile folder.
 */

import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { app } from 'electron';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { getWslInfo } from '../platform/shell-runtime';
import LAUNCHER_SOURCE from './windows-browser-launcher.cjs?raw';
import RELAY_SOURCE from './windows-cdp-relay.cjs?raw';

/** Whether a choice is a Windows Chromium browser while tools run in WSL (runs through the launcher) */
export function isWindowsBrowserInWsl(choice: PlaywrightBrowserChoice | undefined): boolean {
  return !!choice && getWslInfo() !== null && !choice.managed && choice.engine === 'chromium' && /^[A-Za-z]:[\\/]/.test(choice.executablePath);
}

/** Where the launcher and the relay are written (host paths): the app's own data folder, never swept */
export function windowsBrowserScripts(): { launcher: string; relay: string } {
  const dir = path.join(app.getPath('userData'), 'windows-browser');
  return { launcher: path.join(dir, 'windows-browser-launcher.cjs'), relay: path.join(dir, 'windows-cdp-relay.cjs') };
}

let written: Promise<void> | null = null;

/** Write the launcher and the relay (once per app session; again after a failure) */
export function ensureWindowsBrowserScripts(): Promise<void> {
  written ??= (async () => {
    const { launcher, relay } = windowsBrowserScripts();
    await mkdir(path.dirname(launcher), { recursive: true });
    await Promise.all([writeFile(launcher, LAUNCHER_SOURCE, 'utf-8'), writeFile(relay, RELAY_SOURCE, 'utf-8')]);
  })().catch((error: unknown) => {
    written = null;
    throw error;
  });
  return written;
}
