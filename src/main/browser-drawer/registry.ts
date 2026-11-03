/**
 * Playwright's browser registry
 * =============================
 *
 * Every browser @playwright/mcp launches is "bound" (playwright-core's `browser.bind()`): it
 * listens on a local socket (a named pipe on Windows) and writes a descriptor, one JSON file per
 * browser named by its guid, into a registry folder shared by every Playwright on the machine:
 * `<cache>/ms-playwright/b` (`$XDG_CACHE_HOME` or `~/.cache` on Linux, `~/Library/Caches` on
 * macOS, `%LOCALAPPDATA%` on Windows; `PWTEST_SERVER_REGISTRY` overrides it). The descriptor
 * holds the session's title (the MCP client's name, `claude-code` for Claude Code), its workspace
 * folder (the client's first root, else the server's working folder), the socket and the
 * playwright-core it runs. A browser with a profile folder keeps its file after it closes, so a
 * session counts as live only while its socket answers (as Playwright's own dashboard does).
 * Titles starting with `--playwright-internal` are Playwright's (and Workbench's availability
 * probe's) own and never shown.
 */

import { readdir, readFile, stat } from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

export interface RegistryDescriptor {
  guid: string;
  title: string;
  browserName: string;
  workspaceDir?: string;
  /** The socket path (or ws:// URL) the bound browser listens on */
  endpoint?: string;
  playwrightVersion?: string;
  /** The playwright-core package folder that launched the browser */
  playwrightLib?: string;
  /** Playwright's own browser build (no executable of the user's, or one in Playwright's cache) */
  managed?: boolean;
}

/** Sessions with this title prefix are Playwright's own (its dashboard leaves them out too) */
export const INTERNAL_TITLE_PREFIX = '--playwright-internal';

export type RegistryOs = 'linux' | 'macos' | 'windows';

/** The registry folder playwright-core uses (serverRegistry.ts `registryDirectory`) */
export function registryDir(platform: RegistryOs, env: Record<string, string | undefined>, home: string): string {
  if (env.PWTEST_SERVER_REGISTRY) return env.PWTEST_SERVER_REGISTRY;
  const p = platform === 'windows' ? path.win32 : path.posix;
  const cache = platform === 'linux'
    ? env.XDG_CACHE_HOME || p.join(home, '.cache')
    : platform === 'macos'
      ? p.join(home, 'Library', 'Caches')
      : env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  return p.join(cache, 'ms-playwright', 'b');
}

/** This machine's registry folder */
export function defaultRegistryDir(platform: RegistryOs): string {
  return registryDir(platform, process.env, os.homedir());
}

/** A descriptor file's content, or null when it isn't one */
export function parseDescriptor(text: string): RegistryDescriptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const browser = value.browser as Record<string, unknown> | undefined;
  if (!browser || typeof browser.guid !== 'string' || typeof value.title !== 'string') return null;
  const launchOptions = browser.launchOptions as Record<string, unknown> | undefined;
  const executablePath = typeof launchOptions?.executablePath === 'string' ? launchOptions.executablePath : '';
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : typeof value.pipeName === 'string' ? value.pipeName : undefined;
  return {
    guid: browser.guid,
    title: value.title,
    browserName: typeof browser.browserName === 'string' ? browser.browserName : 'chromium',
    ...(typeof value.workspaceDir === 'string' ? { workspaceDir: value.workspaceDir } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(typeof value.playwrightVersion === 'string' ? { playwrightVersion: value.playwrightVersion } : {}),
    ...(typeof value.playwrightLib === 'string' ? { playwrightLib: value.playwrightLib } : {}),
    managed: !executablePath || /[\\/]ms-playwright[\\/]/.test(executablePath),
  };
}

/** Whether a bound browser's socket (or ws:// endpoint) answers */
export function canConnect(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      if (/^wss?:\/\//.test(endpoint)) {
        const url = new URL(endpoint);
        socket = net.createConnection(Number(url.port) || (url.protocol === 'wss:' ? 443 : 80), url.hostname);
      } else {
        socket = net.createConnection(endpoint);
      }
    } catch {
      resolve(false);
      return;
    }
    const done = (result: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Descriptors whose socket didn't answer, by file, with the file's mtime then */
type DeadCache = Map<string, number>;

/**
 * The live sessions in a registry folder (none when it doesn't exist). Files whose browser
 * didn't answer are skipped until they change (`dead`, kept by the caller between reads)
 */
export async function readLiveSessions(
  dir: string,
  dead: DeadCache = new Map(),
  connect: (endpoint: string) => Promise<boolean> = canConnect,
): Promise<RegistryDescriptor[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    dead.clear();
    return [];
  }
  const present = new Set(names);
  for (const name of dead.keys()) if (!present.has(name)) dead.delete(name);
  const results = await Promise.all(names.map(async (name): Promise<RegistryDescriptor | null> => {
    const file = path.join(dir, name);
    try {
      const { mtimeMs, isFile } = await stat(file).then((s) => ({ mtimeMs: s.mtimeMs, isFile: s.isFile() }));
      if (!isFile || dead.get(name) === mtimeMs) return null;
      const descriptor = parseDescriptor(await readFile(file, 'utf-8'));
      if (!descriptor || descriptor.title.startsWith(INTERNAL_TITLE_PREFIX)) return null;
      if (!descriptor.endpoint || !(await connect(descriptor.endpoint))) {
        dead.set(name, mtimeMs);
        return null;
      }
      return descriptor;
    } catch {
      return null;
    }
  }));
  return results.filter((d): d is RegistryDescriptor => d !== null);
}
