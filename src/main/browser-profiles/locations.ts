/**
 * Where each browser keeps its profiles and its executable, per OS. Pure: the OS, home folder and
 * environment are passed in, so every OS's table can be tested anywhere. Paths are the ones tools
 * see where they run (Linux paths in WSL); detect.ts reads them through host paths.
 */

import path from 'path';

/** Node's path functions for one OS (path.posix or path.win32) */
export type PathApi = typeof path.posix;
import type { BrowserEngine, BrowserKind, BrowserProfileDisabledReason } from '../../shared/types/browser-profiles';

export type BrowserOs = 'windows' | 'macos' | 'linux';

/** Snap Firefox's launcher (runs it in the snap's sandbox) and its own binary (runs outside it) */
export const SNAP_FIREFOX_LAUNCHER = '/snap/bin/firefox';
export const SNAP_FIREFOX_BINARY = '/snap/firefox/current/usr/lib/firefox/firefox';
/** Snap Chromium's launcher: runs Chromium confined by the snap's AppArmor profile */
export const SNAP_CHROMIUM_LAUNCHER = '/snap/bin/chromium';

/**
 * Snap launchers runs replace with the snap's own binary, which runs outside the sandbox
 * (mcp-config.ts; detect.ts checks the binary runs on this system)
 */
export const SNAP_UNCONFINED_BINARIES: Readonly<Record<string, string>> = {
  [SNAP_FIREFOX_LAUNCHER]: SNAP_FIREFOX_BINARY,
};

/**
 * Snaps whose browser runs confined: the snap's `home` interface lets it write only non-hidden
 * folders of the home (`owner @{HOME}/[^s.]**`) and the snap's own `~/snap/<name>`, so a run's
 * profile copy goes to `~/snap/<name>/common` (profile-copy.ts). Snap Chromium's inner binary
 * isn't run directly like Firefox's: it needs the libraries of the GNOME content snap, mounted
 * only inside the snap's namespace
 */
export const CONFINED_SNAPS = ['chromium'] as const;

/** The snap a browser runs confined in, from its executable (`/snap/bin/<name>`), or undefined */
export function confinedSnapName(executablePath: string): string | undefined {
  if (executablePath in SNAP_UNCONFINED_BINARIES) return undefined;
  const name = /^\/snap\/bin\/([a-z0-9][a-z0-9-]*)$/.exec(executablePath)?.[1];
  return name;
}

export interface BrowserLocation {
  browser: BrowserKind;
  engine: BrowserEngine;
  /** Tells installs of the same browser apart in profile ids (`snap`, `flatpak`) */
  variant?: string;
  /** Chromium: user data folders (holding `Local State`); Firefox: folders holding profiles.ini */
  dataDirs: string[];
  /** Executables to try, in order */
  executables: string[];
  /** Command names looked up on PATH when no executable above exists (Linux) */
  commands?: string[];
  /** Listed, but never usable */
  disabledReason?: BrowserProfileDisabledReason;
}

export interface BrowserLocationContext {
  home: string;
  env: Record<string, string | undefined>;
}

/** The path functions for an OS's paths */
export function pathApi(os: BrowserOs): PathApi {
  return os === 'windows' ? path.win32 : path.posix;
}

function windowsLocations({ home, env }: BrowserLocationContext): BrowserLocation[] {
  const p = path.win32;
  const localAppData = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const installRoots = [programFiles, programFilesX86, localAppData];
  const installed = (...parts: string[]) => installRoots.map((root) => p.join(root, ...parts));
  return [
    {
      browser: 'chrome', engine: 'chromium',
      dataDirs: [p.join(localAppData, 'Google', 'Chrome', 'User Data')],
      executables: installed('Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    {
      browser: 'edge', engine: 'chromium',
      dataDirs: [p.join(localAppData, 'Microsoft', 'Edge', 'User Data')],
      executables: installed('Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
    {
      browser: 'brave', engine: 'chromium',
      dataDirs: [p.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      executables: installed('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    },
    {
      browser: 'chromium', engine: 'chromium',
      dataDirs: [p.join(localAppData, 'Chromium', 'User Data')],
      executables: installed('Chromium', 'Application', 'chrome.exe'),
    },
    {
      browser: 'firefox', engine: 'firefox',
      dataDirs: [p.join(appData, 'Mozilla', 'Firefox')],
      // Machine-wide (release and ESR install to the same folder), then a per-user install
      executables: installed('Mozilla Firefox', 'firefox.exe'),
    },
  ];
}

function macLocations({ home }: BrowserLocationContext): BrowserLocation[] {
  const p = path.posix;
  const support = p.join(home, 'Library', 'Application Support');
  const app = (bundle: string, binary: string) =>
    ['/Applications', p.join(home, 'Applications')].map((root) => p.join(root, `${bundle}.app`, 'Contents', 'MacOS', binary));
  return [
    { browser: 'chrome', engine: 'chromium', dataDirs: [p.join(support, 'Google', 'Chrome')], executables: app('Google Chrome', 'Google Chrome') },
    { browser: 'edge', engine: 'chromium', dataDirs: [p.join(support, 'Microsoft Edge')], executables: app('Microsoft Edge', 'Microsoft Edge') },
    { browser: 'brave', engine: 'chromium', dataDirs: [p.join(support, 'BraveSoftware', 'Brave-Browser')], executables: app('Brave Browser', 'Brave Browser') },
    { browser: 'chromium', engine: 'chromium', dataDirs: [p.join(support, 'Chromium')], executables: app('Chromium', 'Chromium') },
    { browser: 'firefox', engine: 'firefox', dataDirs: [p.join(support, 'Firefox')], executables: app('Firefox', 'firefox') },
    // Listed so the user sees why it can't be picked; it has no profiles Puppeteer could read
    {
      browser: 'safari', engine: 'webkit', dataDirs: [],
      executables: ['/Applications/Safari.app/Contents/MacOS/Safari'],
      disabledReason: 'unsupported-engine',
    },
  ];
}

function linuxLocations({ home, env }: BrowserLocationContext): BrowserLocation[] {
  const p = path.posix;
  // Chromium browsers (and Firefox from 147 for new profiles) follow XDG_CONFIG_HOME; a relative
  // value is invalid by the spec and ignored, as the browsers do
  const config = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  const flatpak = (appId: string, ...parts: string[]) => p.join(home, '.var', 'app', appId, ...parts);
  const sandboxed = { variant: 'flatpak', executables: [], disabledReason: 'sandboxed-package' as const };
  return [
    {
      browser: 'chrome', engine: 'chromium',
      dataDirs: [p.join(config, 'google-chrome')],
      executables: ['/opt/google/chrome/chrome'],
      commands: ['google-chrome-stable', 'google-chrome'],
    },
    {
      browser: 'edge', engine: 'chromium',
      dataDirs: [p.join(config, 'microsoft-edge')],
      executables: ['/opt/microsoft/msedge/msedge'],
      commands: ['microsoft-edge-stable', 'microsoft-edge'],
    },
    {
      browser: 'brave', engine: 'chromium',
      dataDirs: [p.join(config, 'BraveSoftware', 'Brave-Browser')],
      executables: ['/opt/brave.com/brave/brave'],
      commands: ['brave-browser', 'brave'],
    },
    {
      browser: 'chromium', engine: 'chromium',
      dataDirs: [p.join(config, 'chromium')],
      executables: ['/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser'],
      commands: ['chromium', 'chromium-browser'],
    },
    {
      browser: 'chromium', engine: 'chromium', variant: 'snap',
      dataDirs: [p.join(home, 'snap', 'chromium', 'common', 'chromium')],
      executables: [SNAP_CHROMIUM_LAUNCHER],
    },
    {
      browser: 'firefox', engine: 'firefox',
      dataDirs: [p.join(home, '.mozilla', 'firefox'), p.join(config, 'mozilla', 'firefox')],
      // Distribution packages, Mozilla's tarball in /opt, then Debian's default ESR
      executables: [
        '/usr/lib/firefox/firefox', '/usr/lib64/firefox/firefox', '/opt/firefox/firefox',
        '/usr/lib/firefox-esr/firefox-esr', '/usr/lib64/firefox-esr/firefox-esr',
      ],
      commands: ['firefox', 'firefox-esr'],
    },
    {
      browser: 'firefox', engine: 'firefox', variant: 'snap',
      dataDirs: [p.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')],
      executables: [SNAP_FIREFOX_LAUNCHER],
    },
    { browser: 'chrome', engine: 'chromium', dataDirs: [flatpak('com.google.Chrome', 'config', 'google-chrome')], ...sandboxed },
    { browser: 'edge', engine: 'chromium', dataDirs: [flatpak('com.microsoft.Edge', 'config', 'microsoft-edge')], ...sandboxed },
    { browser: 'brave', engine: 'chromium', dataDirs: [flatpak('com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser')], ...sandboxed },
    { browser: 'chromium', engine: 'chromium', dataDirs: [flatpak('org.chromium.Chromium', 'config', 'chromium')], ...sandboxed },
    { browser: 'firefox', engine: 'firefox', dataDirs: [flatpak('org.mozilla.firefox', '.mozilla', 'firefox')], ...sandboxed },
  ];
}

/** Every browser's profile and executable locations on an OS */
export function browserLocations(os: BrowserOs, context: BrowserLocationContext): BrowserLocation[] {
  switch (os) {
    case 'windows':
      return windowsLocations(context);
    case 'macos':
      return macLocations(context);
    default:
      return linuxLocations(context);
  }
}
