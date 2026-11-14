/**
 * The browser profile choice that is stored when a profile is picked (the renderer's pickers; the
 * main process maps a chat's choice to its Windows profile with it, browser-drawer/browser-runtime.ts)
 */

import type { BrowserProfile, PlaywrightBrowserChoice } from '../types/browser-profiles';

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
