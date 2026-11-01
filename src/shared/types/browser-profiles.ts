/**
 * Local browser profiles the Puppeteer connector can use (Settings > Connectors). Detected in the
 * main process (src/main/browser-profiles/); the choice is stored whole in
 * McpConnectorSettings.puppeteerBrowser, so runs never need to detect again.
 */

export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'chromium' | 'firefox' | 'safari';

/** Puppeteer drives Chromium and Firefox; WebKit (Safari) isn't supported */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

/** Why a detected profile can't be used (translated in the renderer) */
export type BrowserProfileDisabledReason =
  /** Puppeteer can't drive the browser's engine (Safari) */
  | 'unsupported-engine'
  /** The browser's profiles are there but its executable isn't */
  | 'executable-missing'
  /** A Windows browser while tools run in WSL, where it can't be started */
  | 'windows-browser-in-wsl'
  /** A Flatpak browser: its sandbox keeps it from being started with another profile folder */
  | 'sandboxed-package'
  /** A browser Puppeteer downloads itself, not downloaded yet */
  | 'not-downloaded';

/** Browsers Puppeteer can download itself (`npx puppeteer browsers install <name>`) */
export type DownloadableBrowser = 'chrome' | 'firefox';

export interface BrowserProfile {
  /** `<browser>:<profile folder>`, e.g. `chrome:Profile 1` */
  id: string;
  browser: BrowserKind;
  engine: BrowserEngine;
  /** The name the browser shows for the profile */
  profileName: string;
  /** How the browser is packaged when that tells installs apart (`snap`, `flatpak`) */
  variant?: string;
  /** The signed-in account, when the browser knows it */
  email?: string;
  /** Chromium: the user data folder holding `Local State`; Firefox: the folder holding profiles.ini */
  userDataDir: string;
  /** Chromium: the profile's folder name inside userDataDir (`Default`, `Profile 1`) */
  profileDirectory?: string;
  /** The profile's own folder */
  profilePath: string;
  /** The browser's executable, where tools run (a Linux path in WSL) */
  executablePath?: string;
  usable: boolean;
  disabledReason?: BrowserProfileDisabledReason;
  /** Puppeteer's own download of the browser (no user profile: it starts with a new one) */
  managed?: boolean;
  /** Set while the browser can be downloaded: which one the download button installs */
  downloadable?: DownloadableBrowser;
}

/** The profile the Puppeteer connector uses (unset: Puppeteer's own Chrome) */
export interface PuppeteerBrowserChoice {
  id: string;
  browser: BrowserKind;
  engine: 'chromium' | 'firefox';
  profileName: string;
  variant?: string;
  /** Puppeteer's own download of the browser: no profile copy, a new profile each launch */
  managed?: boolean;
  email?: string;
  executablePath: string;
  userDataDir: string;
  profileDirectory?: string;
  profilePath: string;
}
