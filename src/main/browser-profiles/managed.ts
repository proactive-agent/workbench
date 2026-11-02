/**
 * Browsers Playwright downloads itself
 * ====================================
 *
 * The Playwright connector runs a pinned @playwright/mcp (PLAYWRIGHT_MCP_PACKAGE), whose
 * playwright-core needs one build of each browser (its browsers.json: PLAYWRIGHT_BUILDS).
 * `npx -y @playwright/mcp@<version> install-browser <name>` puts a build in Playwright's cache
 * (`PLAYWRIGHT_BROWSERS_PATH`, else `~/.cache/ms-playwright` on Linux (`$XDG_CACHE_HOME`),
 * `~/Library/Caches/ms-playwright` on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows), one folder
 * per build (`firefox-1553`) holding `INSTALLATION_COMPLETE` once unpacked. The picker lists
 * Firefox and WebKit as "Playwright's Firefox" / "Playwright's WebKit": usable once their build is
 * in the cache, otherwise disabled with a download button. Playwright's Chromium is the picker's
 * default entry, so it isn't listed here.
 */

import { readdir, access } from 'fs/promises';
import type { BrowserProfile, DownloadableBrowser } from '../../shared/types/browser-profiles';
import { pathApi, type BrowserOs } from './locations';

/** The Playwright MCP server's version: bump it together with PLAYWRIGHT_BUILDS */
export const PLAYWRIGHT_MCP_VERSION = '0.0.83';
/** What npx runs for the Playwright connector */
export const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;

/** A build Playwright downloads: its cache folder (`<name>-<revision>`) and where its executable sits, per OS */
interface PlaywrightBuild {
  /** Cache folders of the build, the first one that holds a finished download counts */
  folders: Partial<Record<BrowserOs, string[]>> & { default: string[] };
  executables: Record<BrowserOs, string[][]>;
}

/**
 * The builds @playwright/mcp@0.0.83 needs (playwright-core's browsers.json: chromium 1247 is
 * Chrome for Testing 155, firefox 1553 is Firefox 156, webkit 2368 is WebKit 26.6, 2251 on macOS 14,
 * in its own folder)
 */
export const PLAYWRIGHT_BUILDS: Readonly<Record<DownloadableBrowser, PlaywrightBuild>> = {
  chromium: {
    folders: { default: ['chromium-1247'] },
    executables: {
      linux: [['chrome-linux64', 'chrome'], ['chrome-linux-arm64', 'chrome']],
      macos: [
        ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
        ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ],
      windows: [['chrome-win64', 'chrome.exe']],
    },
  },
  firefox: {
    folders: { default: ['firefox-1553'] },
    executables: {
      linux: [['firefox', 'firefox']],
      macos: [['firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox']],
      windows: [['firefox', 'firefox.exe']],
    },
  },
  webkit: {
    // macOS 14's override goes to `<name>_<host platform>_special-<revision>` (dashes as `_`)
    folders: { default: ['webkit-2368'], macos: ['webkit-2368', 'webkit_mac14_arm64_special-2251', 'webkit_mac14_special-2251'] },
    executables: {
      linux: [['pw_run.sh']],
      macos: [['pw_run.sh']],
      windows: [['Playwright.exe']],
    },
  },
};

/** Written into a build's folder once it is unpacked */
const INSTALLATION_COMPLETE = 'INSTALLATION_COMPLETE';

/** The command a download button runs (opened in a terminal by the main process) */
export function playwrightInstallCommand(browser: DownloadableBrowser): string {
  return `npx -y ${PLAYWRIGHT_MCP_PACKAGE} install-browser ${browser}`;
}

export interface ManagedScanContext {
  os: BrowserOs;
  home: string;
  env: Record<string, string | undefined>;
  /** A path of the OS's table -> the path this process reads it with */
  toHost: (p: string) => string;
}

/** Playwright's cache folder where tools run (`PLAYWRIGHT_BROWSERS_PATH=0`, a folder inside the package, can't be known here) */
export function playwrightCacheDir({ os, home, env }: ManagedScanContext): string {
  const p = pathApi(os);
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0' && p.isAbsolute(custom)) return custom;
  if (os === 'windows') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (os === 'macos') return p.join(home, 'Library', 'Caches', 'ms-playwright');
  const cache = env.XDG_CACHE_HOME && p.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : p.join(home, '.cache');
  return p.join(cache, 'ms-playwright');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** The executable of a downloaded build the pinned server needs (a path where tools run), or undefined */
export async function findManagedBrowser(browser: DownloadableBrowser, context: ManagedScanContext): Promise<string | undefined> {
  const p = pathApi(context.os);
  const root = playwrightCacheDir(context);
  const build = PLAYWRIGHT_BUILDS[browser];
  let entries: string[];
  try {
    entries = await readdir(context.toHost(root));
  } catch {
    return undefined;
  }
  for (const folder of build.folders[context.os] ?? build.folders.default) {
    if (!entries.includes(folder)) continue;
    const dir = p.join(root, folder);
    // Still being unpacked (or an interrupted download)
    if (!(await exists(context.toHost(p.join(dir, INSTALLATION_COMPLETE))))) continue;
    for (const parts of build.executables[context.os]) {
      const executable = p.join(dir, ...parts);
      if (await exists(context.toHost(executable))) return executable;
    }
  }
  return undefined;
}

const MANAGED_LISTED: { browser: DownloadableBrowser; name: string }[] = [
  { browser: 'firefox', name: 'Firefox' },
  { browser: 'webkit', name: 'WebKit' },
];

/** "Playwright's Firefox" and "Playwright's WebKit" for the picker: usable when downloaded, else downloadable */
export async function scanManagedBrowsers(context: ManagedScanContext): Promise<BrowserProfile[]> {
  return Promise.all(MANAGED_LISTED.map(async ({ browser, name }) => {
    const executablePath = await findManagedBrowser(browser, context);
    return {
      id: `playwright:${browser}`,
      browser,
      engine: browser,
      managed: true,
      profileName: name,
      userDataDir: '',
      profilePath: '',
      ...(executablePath ? { executablePath, usable: true } : { usable: false, disabledReason: 'not-downloaded' as const, downloadable: browser }),
    };
  }));
}
