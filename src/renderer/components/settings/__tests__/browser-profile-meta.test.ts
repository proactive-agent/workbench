import { describe, it, expect } from 'vitest';
import { browserProfileLabel, disabledReasonText, refreshedBrowserChoice, storedChoiceProfile, toBrowserChoice } from '../browser-profile-meta';
import type { BrowserProfile } from '../../../../shared/types/browser-profiles';

const t = (key: string) => key.split('.').at(-1) ?? key;

const chrome: BrowserProfile = {
  id: 'chrome:Default',
  browser: 'chrome',
  engine: 'chromium',
  profileName: 'Work',
  email: 'me@work.example',
  userDataDir: '/u',
  profileDirectory: 'Default',
  profilePath: '/u/Default',
  executablePath: '/opt/google/chrome/chrome',
  usable: true,
};

describe('browser profile picker helpers', () => {
  it('labels profiles with their browser', () => {
    expect(browserProfileLabel(t, chrome)).toBe('chrome · Work');
    expect(browserProfileLabel(t, { ...chrome, variant: 'snap' })).toBe('chrome (snap) · Work');
    expect(browserProfileLabel(t, { browser: 'safari', profileName: 'Safari' })).toBe('safari');
  });

  it('stores only usable profiles, with what runs need', () => {
    expect(toBrowserChoice(chrome)).toEqual({
      id: 'chrome:Default',
      browser: 'chrome',
      engine: 'chromium',
      profileName: 'Work',
      email: 'me@work.example',
      executablePath: '/opt/google/chrome/chrome',
      userDataDir: '/u',
      profileDirectory: 'Default',
      profilePath: '/u/Default',
    });
    expect(toBrowserChoice({ ...chrome, usable: false, disabledReason: 'executable-missing', executablePath: undefined })).toBeUndefined();
  });

  it("labels Playwright's own download without a profile name and stores it as managed", () => {
    const firefox: BrowserProfile = {
      id: 'playwright:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      userDataDir: '', profilePath: '', executablePath: '/c/firefox', usable: true,
    };
    expect(browserProfileLabel(t, firefox)).toBe('managed');
    expect(toBrowserChoice(firefox)).toMatchObject({ id: 'playwright:firefox', managed: true, executablePath: '/c/firefox' });
    expect(toBrowserChoice({ ...firefox, usable: false, executablePath: undefined, disabledReason: 'not-downloaded', downloadable: 'firefox' })).toBeUndefined();
    expect(disabledReasonText(t, 'not-downloaded')).toBe('notDownloaded');
  });

  it("stores Playwright's own WebKit as a choice, never Safari", () => {
    const webkit: BrowserProfile = {
      id: 'playwright:webkit', browser: 'webkit', engine: 'webkit', managed: true, profileName: 'WebKit',
      userDataDir: '', profilePath: '', executablePath: '/c/webkit/pw_run.sh', usable: true,
    };
    expect(toBrowserChoice(webkit)).toMatchObject({ id: 'playwright:webkit', engine: 'webkit', managed: true, executablePath: '/c/webkit/pw_run.sh' });
    const safari: BrowserProfile = {
      id: 'safari:default', browser: 'safari', engine: 'webkit', profileName: 'Safari',
      userDataDir: '', profilePath: '', executablePath: '/Applications/Safari.app/Contents/MacOS/Safari', usable: true,
    };
    expect(toBrowserChoice(safari)).toBeUndefined();
  });

  it('gives each disabled reason as text', () => {
    expect(disabledReasonText(t, 'unsupported-engine')).toBe('unsupportedEngine');
    expect(disabledReasonText(t, 'windows-browser-in-wsl')).toBe('windowsBrowserInWsl');
    expect(disabledReasonText(t, undefined)).toBeUndefined();
  });

  it('remakes a stored choice whose detected paths changed', () => {
    const stored = toBrowserChoice(chrome)!;
    expect(refreshedBrowserChoice(stored, [chrome])).toBeUndefined();
    expect(refreshedBrowserChoice(stored, [{ ...chrome, executablePath: '/opt/new/chrome' }])).toEqual({ ...stored, executablePath: '/opt/new/chrome' });
    expect(refreshedBrowserChoice(stored, [{ ...chrome, profilePath: '/u/Default/' }])).toEqual({ ...stored, profilePath: '/u/Default/' });
    // Not detected, or no longer usable: kept as it is
    expect(refreshedBrowserChoice(stored, [])).toBeUndefined();
    expect(refreshedBrowserChoice(stored, [{ ...chrome, usable: false, executablePath: undefined }])).toBeUndefined();
    expect(refreshedBrowserChoice(undefined, [chrome])).toBeUndefined();
  });

  it("never takes another install's profile with the same id (a shell runtime switch)", () => {
    const windows: BrowserProfile = {
      ...chrome,
      userDataDir: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
      profilePath: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    };
    const wslLinux: BrowserProfile = { ...chrome, userDataDir: '/home/me/.config/google-chrome', profilePath: '/home/me/.config/google-chrome/Default' };
    const stored = toBrowserChoice(windows)!;
    // Native Windows -> WSL: the Linux Chrome has the same id but is another browser and account
    expect(storedChoiceProfile(stored, [wslLinux])).toBeUndefined();
    expect(refreshedBrowserChoice(stored, [wslLinux])).toBeUndefined();
    // The same install, its folder spelled with other case or slashes: still it
    const respelled = { ...windows, userDataDir: 'c:/users/me/AppData/Local/Google/Chrome/User Data/', executablePath: 'D:\\chrome.exe' };
    expect(storedChoiceProfile(stored, [respelled])).toBe(respelled);
    expect(refreshedBrowserChoice(stored, [respelled])?.executablePath).toBe('D:\\chrome.exe');
    // Playwright's own download: any build will do
    const managed: BrowserProfile = {
      id: 'playwright:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      userDataDir: '', profilePath: '', executablePath: '/c/firefox', usable: true,
    };
    expect(refreshedBrowserChoice(toBrowserChoice(managed)!, [{ ...managed, executablePath: '/d/firefox' }])?.executablePath).toBe('/d/firefox');
  });
});
