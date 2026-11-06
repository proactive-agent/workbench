/**
 * Browser profile picker helpers (Playwright connector, Settings > Connectors). Kept out of
 * PlaywrightBrowserSelect.tsx so that file only exports components (Fast Refresh)
 */

import { Globe } from 'lucide-react';
import { ChromiumIcon, FirefoxIcon, PlaywrightIcon } from '../icons/app-icons';
import type {
  BrowserProfile,
  BrowserProfileDisabledReason,
  PlaywrightBrowserChoice,
} from '../../../shared/types/browser-profiles';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The select's value for Playwright's own Chromium */
export const DEFAULT_BROWSER_VALUE = 'default';

/** The select's value for a stored choice that isn't detected any more (its id may be another install's) */
export const MISSING_BROWSER_VALUE = 'missing';

const REASON_KEYS: Record<BrowserProfileDisabledReason, string> = {
  'unsupported-engine': 'settings:mcp.browserProfile.reasons.unsupportedEngine',
  'executable-missing': 'settings:mcp.browserProfile.reasons.executableMissing',
  'windows-browser-in-wsl': 'settings:mcp.browserProfile.reasons.windowsBrowserInWsl',
  'needs-firefox-in-wsl': 'settings:mcp.browserProfile.reasons.needsFirefoxInWsl',
  'sandboxed-package': 'settings:mcp.browserProfile.reasons.sandboxedPackage',
  'not-downloaded': 'settings:mcp.browserProfile.reasons.notDownloaded',
  'snap-needs-newer-glibc': 'settings:mcp.browserProfile.reasons.snapNeedsNewerGlibc',
};

/** Why a profile can't be picked, as text */
export function disabledReasonText(t: Translate, reason: BrowserProfileDisabledReason | undefined): string | undefined {
  return reason ? t(REASON_KEYS[reason]) : undefined;
}

/** A picker item's icon: Playwright's for its own browsers, otherwise the browser engine's */
export function browserProfileIcon(profile: Pick<BrowserProfile, 'engine' | 'managed'>): React.ElementType {
  if (profile.managed) return PlaywrightIcon;
  if (profile.engine === 'firefox') return FirefoxIcon;
  if (profile.engine === 'chromium') return ChromiumIcon;
  return Globe;
}

/** `Chrome · Work` (Safari has a single entry: just the browser) */
export function browserProfileLabel(t: Translate, profile: Pick<BrowserProfile, 'browser' | 'profileName' | 'variant' | 'managed'>): string {
  const name = t(`settings:mcp.browserProfile.browsers.${profile.browser}`);
  // `Firefox (Snap)` where the same browser is installed in more than one way
  const browser = profile.variant ? `${name} (${t(`settings:mcp.browserProfile.variants.${profile.variant}`)})` : name;
  // Playwright's own download has no profile to name
  if (profile.managed) return t('settings:mcp.browserProfile.managed', { browser: name });
  return profile.browser === 'safari' ? browser : `${browser} · ${profile.profileName}`;
}

/** What gets stored when a profile is picked (undefined for profiles that can't be used) */
export function toBrowserChoice(profile: BrowserProfile): PlaywrightBrowserChoice | undefined {
  // WebKit only as Playwright's own build (Safari can't be driven)
  if (!profile.usable || !profile.executablePath || (profile.engine === 'webkit' && !profile.managed)) return undefined;
  return {
    id: profile.id,
    browser: profile.browser,
    engine: profile.engine,
    profileName: profile.profileName,
    ...(profile.variant ? { variant: profile.variant } : {}),
    ...(profile.managed ? { managed: true } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    executablePath: profile.executablePath,
    userDataDir: profile.userDataDir,
    ...(profile.profileDirectory ? { profileDirectory: profile.profileDirectory } : {}),
    profilePath: profile.profilePath,
  };
}

/** A user data folder as a key: Windows paths (drive or UNC) compare without case and slash style */
function folderKey(dir: string): string {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(dir) ? dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : dir.replace(/\/+$/, '');
}

/**
 * Whether a detected profile is the stored choice's install, not only its id: native Windows and
 * WSL detection (or another install) give the same ids (`chrome:Default`) to profiles of other
 * browsers, signed in to other accounts. Playwright's own downloads have no profile, so any of
 * them will do
 */
function sameInstall(value: PlaywrightBrowserChoice, profile: BrowserProfile): boolean {
  if (profile.id !== value.id || profile.engine !== value.engine) return false;
  if (value.managed || profile.managed) return !!value.managed === !!profile.managed;
  return folderKey(profile.userDataDir) === folderKey(value.userDataDir);
}

/** The detected profile the stored choice was made from (undefined when it isn't detected any more) */
export function storedChoiceProfile(
  value: PlaywrightBrowserChoice | undefined,
  profiles: BrowserProfile[] | undefined
): BrowserProfile | undefined {
  return value ? profiles?.find((p) => sameInstall(value, p)) : undefined;
}

/**
 * The stored choice made again from its detected profile, when the paths runs use changed (a new
 * download of Playwright's browser, a moved executable); undefined when it is up to date, gone or
 * unusable. A profile with the same id from another install (a shell runtime switch) is never taken
 */
export function refreshedBrowserChoice(
  value: PlaywrightBrowserChoice | undefined,
  profiles: BrowserProfile[] | undefined
): PlaywrightBrowserChoice | undefined {
  const profile = storedChoiceProfile(value, profiles);
  const choice = profile ? toBrowserChoice(profile) : undefined;
  if (!value || !choice) return undefined;
  const fields = ['engine', 'executablePath', 'userDataDir', 'profileDirectory', 'profilePath', 'managed'] as const;
  return fields.some((field) => choice[field] !== value[field]) ? choice : undefined;
}
