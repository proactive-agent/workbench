/**
 * Browser profile detection
 * =========================
 *
 * Finds the installed Chromium-family browsers (Chrome, Edge, Brave, Chromium) and Firefox and
 * lists their profiles for the Puppeteer connector (Settings > Connectors). A profile is usable
 * when Puppeteer can drive its engine and the browser's executable exists where tools run.
 *
 * When tools run in WSL, Puppeteer starts inside the distribution: its browsers are read through
 * `\\wsl.localhost` paths and stored with their Linux paths, and Windows browsers are listed but
 * can't be used. Only async file reads; command lookups go through mcp-commands (async, cached).
 * Runs once at startup; `refresh` looks again.
 */

import os from 'os';
import { access, readFile } from 'fs/promises';
import type { BrowserProfile } from '../../shared/types/browser-profiles';
import { isMacOS, isWindows } from '../platform';
import { getWslInfo, toHostPath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { resolveCommand } from '../mcp-commands';
import { appLog } from '../app-logger';
import { browserLocations, pathApi, type BrowserLocation, type BrowserOs } from './locations';
import { parseChromiumLocalState, parseFirefoxProfilesIni } from './parsing';

const BROWSER_ORDER = ['chrome', 'edge', 'brave', 'chromium', 'firefox', 'safari'];

interface ScanContext {
  os: BrowserOs;
  home: string;
  env: Record<string, string | undefined>;
  /** A path from the table -> the path this process reads it with */
  toHost: (p: string) => string;
  /** Whether PATH lookups apply (they look where tools run) */
  lookUpCommands: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function findExecutable(location: BrowserLocation, context: ScanContext): Promise<string | undefined> {
  for (const candidate of location.executables) {
    if (await exists(context.toHost(candidate))) return candidate;
  }
  if (!context.lookUpCommands) return undefined;
  for (const command of location.commands ?? []) {
    const found = await resolveCommand(command);
    if (found) return found;
  }
  return undefined;
}

function profileId(location: BrowserLocation, folder: string): string {
  return `${location.browser}${location.variant ? `-${location.variant}` : ''}:${folder}`;
}

async function scanLocation(location: BrowserLocation, context: ScanContext): Promise<BrowserProfile[]> {
  const p = pathApi(context.os);
  const found: Omit<BrowserProfile, 'usable' | 'executablePath'>[] = [];

  if (location.engine === 'webkit') {
    // Safari: one entry when it is installed, never usable
    const app = location.executables[0];
    if (app && (await exists(context.toHost(app)))) {
      found.push({ id: `${location.browser}:default`, browser: location.browser, engine: location.engine, profileName: 'Safari', userDataDir: '', profilePath: '' });
    }
  }

  for (const dataDir of location.dataDirs) {
    if (location.engine === 'chromium') {
      const text = await readText(context.toHost(p.join(dataDir, 'Local State')));
      if (text === null) continue;
      for (const entry of parseChromiumLocalState(text)) {
        const profilePath = p.join(dataDir, entry.directory);
        // Listed in Local State but deleted since
        if (!(await exists(context.toHost(profilePath)))) continue;
        found.push({
          id: profileId(location, entry.directory),
          browser: location.browser,
          engine: location.engine,
          ...(location.variant ? { variant: location.variant } : {}),
          profileName: entry.name,
          ...(entry.email ? { email: entry.email } : {}),
          userDataDir: dataDir,
          profileDirectory: entry.directory,
          profilePath,
        });
      }
    } else if (location.engine === 'firefox') {
      const text = await readText(context.toHost(p.join(dataDir, 'profiles.ini')));
      if (text === null) continue;
      for (const entry of parseFirefoxProfilesIni(text, dataDir, p)) {
        if (!(await exists(context.toHost(entry.path)))) continue;
        found.push({
          id: profileId(location, entry.folder),
          browser: location.browser,
          engine: location.engine,
          ...(location.variant ? { variant: location.variant } : {}),
          profileName: entry.name,
          userDataDir: dataDir,
          profilePath: entry.path,
        });
      }
    }
  }
  if (found.length === 0) return [];

  const executablePath = location.disabledReason ? undefined : await findExecutable(location, context);
  const disabledReason = location.disabledReason ?? (executablePath ? undefined : 'executable-missing');
  return found.map((profile) => ({
    ...profile,
    ...(executablePath ? { executablePath } : {}),
    usable: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
  }));
}

/** Every profile of the browsers in one OS's table; a browser that can't be read is skipped */
export async function scanBrowserProfiles(context: ScanContext): Promise<BrowserProfile[]> {
  const profiles: BrowserProfile[] = [];
  const seen = new Set<string>();
  for (const location of browserLocations(context.os, context)) {
    try {
      for (const profile of await scanLocation(location, context)) {
        if (seen.has(profile.id)) continue;
        seen.add(profile.id);
        profiles.push(profile);
      }
    } catch (error) {
      appLog.warn(`[BrowserProfiles] Could not read ${location.browser} profiles:`, error);
    }
  }
  // Grouped by browser in a fixed order; profiles keep the browser's own order
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => BROWSER_ORDER.indexOf(a.profile.browser) - BROWSER_ORDER.indexOf(b.profile.browser) || a.index - b.index)
    .map(({ profile }) => profile);
}

function nativeOs(): BrowserOs {
  if (isWindows()) return 'windows';
  if (isMacOS()) return 'macos';
  return 'linux';
}

async function detect(): Promise<BrowserProfile[]> {
  await whenShellRuntimeReady();
  const wsl = getWslInfo();
  const native: ScanContext = { os: nativeOs(), home: os.homedir(), env: process.env, toHost: (p) => p, lookUpCommands: !isWindows() };
  if (!wsl) return scanBrowserProfiles(native);

  // Tools (and so Puppeteer) run in the distribution: its own browsers can be used, Windows ones can't
  const linux = await scanBrowserProfiles({ os: 'linux', home: wsl.home, env: {}, toHost: toHostPath, lookUpCommands: true });
  const windows = (await scanBrowserProfiles({ ...native, lookUpCommands: false })).map((profile) => ({
    ...profile,
    id: `windows-${profile.id}`,
    usable: false,
    disabledReason: 'windows-browser-in-wsl' as const,
  }));
  return [...linux, ...windows];
}

let detection: Promise<BrowserProfile[]> | null = null;

/** The detected browser profiles (looked for once; `refresh` looks again) */
export function detectBrowserProfiles(options: { refresh?: boolean } = {}): Promise<BrowserProfile[]> {
  if (!detection || options.refresh) {
    detection = detect().catch((error: unknown) => {
      appLog.warn('[BrowserProfiles] Detection failed:', error);
      return [];
    });
  }
  return detection;
}
