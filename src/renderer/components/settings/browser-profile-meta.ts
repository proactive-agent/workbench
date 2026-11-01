/**
 * Browser profile picker helpers (Puppeteer connector, Settings > Connectors). Kept out of
 * PuppeteerBrowserSelect.tsx so that file only exports components (Fast Refresh)
 */

import type {
  BrowserProfile,
  BrowserProfileDisabledReason,
  PuppeteerBrowserChoice,
} from '../../../shared/types/browser-profiles';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The select's value for Puppeteer's own Chrome */
export const DEFAULT_BROWSER_VALUE = 'default';

const REASON_KEYS: Record<BrowserProfileDisabledReason, string> = {
  'unsupported-engine': 'settings:mcp.browserProfile.reasons.unsupportedEngine',
  'executable-missing': 'settings:mcp.browserProfile.reasons.executableMissing',
  'windows-browser-in-wsl': 'settings:mcp.browserProfile.reasons.windowsBrowserInWsl',
  'sandboxed-package': 'settings:mcp.browserProfile.reasons.sandboxedPackage',
};

/** Why a profile can't be picked, as text */
export function disabledReasonText(t: Translate, reason: BrowserProfileDisabledReason | undefined): string | undefined {
  return reason ? t(REASON_KEYS[reason]) : undefined;
}

/** `Chrome · Work` (Safari has a single entry: just the browser) */
export function browserProfileLabel(t: Translate, profile: Pick<BrowserProfile, 'browser' | 'profileName' | 'variant'>): string {
  const name = t(`settings:mcp.browserProfile.browsers.${profile.browser}`);
  // `Firefox (Snap)` where the same browser is installed in more than one way
  const browser = profile.variant ? `${name} (${t(`settings:mcp.browserProfile.variants.${profile.variant}`)})` : name;
  return profile.browser === 'safari' ? browser : `${browser} · ${profile.profileName}`;
}

/** What gets stored when a profile is picked (undefined for profiles that can't be used) */
export function toBrowserChoice(profile: BrowserProfile): PuppeteerBrowserChoice | undefined {
  if (!profile.usable || !profile.executablePath || profile.engine === 'webkit') return undefined;
  return {
    id: profile.id,
    browser: profile.browser,
    engine: profile.engine,
    profileName: profile.profileName,
    ...(profile.variant ? { variant: profile.variant } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    executablePath: profile.executablePath,
    userDataDir: profile.userDataDir,
    ...(profile.profileDirectory ? { profileDirectory: profile.profileDirectory } : {}),
    profilePath: profile.profilePath,
  };
}
