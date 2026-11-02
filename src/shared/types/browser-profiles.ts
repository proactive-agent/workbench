/**
 * Local browser profiles the Playwright connector can use (Settings > Connectors). Detected in the
 * main process (src/main/browser-profiles/); the choice is stored whole in
 * McpConnectorSettings.playwrightBrowser, so runs never need to detect again.
 */

/** `webkit`: Playwright's own WebKit build (Safari itself can't be driven) */
export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'chromium' | 'firefox' | 'safari' | 'webkit';

/** Playwright drives Chromium, Firefox and its own WebKit build (not Safari) */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

/** Why a detected profile can't be used (translated in the renderer) */
export type BrowserProfileDisabledReason =
  /** Playwright can't drive the browser (Safari) */
  | 'unsupported-engine'
  /** The browser's profiles are there but its executable isn't */
  | 'executable-missing'
  /** A Windows browser while tools run in WSL, where it can't be started */
  | 'windows-browser-in-wsl'
  /** A Flatpak browser: its sandbox keeps it from being started with another profile folder */
  | 'sandboxed-package'
  /** A browser Playwright downloads itself, not downloaded yet */
  | 'not-downloaded'
  /** Snap Firefox whose binary needs a newer glibc than the system has (it only runs in the snap) */
  | 'snap-needs-newer-glibc';

/** Browsers Playwright downloads itself (`npx @playwright/mcp install-browser <name>`) */
export type DownloadableBrowser = 'chromium' | 'firefox' | 'webkit';

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
  /** Playwright's own download of the browser (no user profile: it starts with a new one) */
  managed?: boolean;
  /** Set while the browser can be downloaded: which one the download button installs */
  downloadable?: DownloadableBrowser;
}

/** The profile the Playwright connector uses (unset: Playwright's own Chromium) */
export interface PlaywrightBrowserChoice {
  id: string;
  browser: BrowserKind;
  /** `webkit` only for Playwright's own WebKit (managed) */
  engine: BrowserEngine;
  profileName: string;
  variant?: string;
  /** Playwright's own download of the browser: no profile copy, a new profile each launch */
  managed?: boolean;
  email?: string;
  executablePath: string;
  userDataDir: string;
  profileDirectory?: string;
  profilePath: string;
}
