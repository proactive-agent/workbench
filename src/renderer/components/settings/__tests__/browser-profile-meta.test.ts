import { describe, it, expect } from 'vitest';
import { browserProfileLabel, disabledReasonText, refreshedBrowserChoice, toBrowserChoice } from '../browser-profile-meta';
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

  it("labels Puppeteer's own download without a profile name and stores it as managed", () => {
    const firefox: BrowserProfile = {
      id: 'puppeteer:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      userDataDir: '', profilePath: '', executablePath: '/c/firefox', usable: true,
    };
    expect(browserProfileLabel(t, firefox)).toBe('managed');
    expect(toBrowserChoice(firefox)).toMatchObject({ id: 'puppeteer:firefox', managed: true, executablePath: '/c/firefox' });
    expect(toBrowserChoice({ ...firefox, usable: false, executablePath: undefined, disabledReason: 'not-downloaded', downloadable: 'firefox' })).toBeUndefined();
    expect(disabledReasonText(t, 'not-downloaded')).toBe('notDownloaded');
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
    expect(refreshedBrowserChoice(stored, [{ ...chrome, userDataDir: '/v', profilePath: '/v/Default' }]))
      .toEqual({ ...stored, userDataDir: '/v', profilePath: '/v/Default' });
    // Not detected, or no longer usable: kept as it is
    expect(refreshedBrowserChoice(stored, [])).toBeUndefined();
    expect(refreshedBrowserChoice(stored, [{ ...chrome, usable: false, executablePath: undefined }])).toBeUndefined();
    expect(refreshedBrowserChoice(undefined, [chrome])).toBeUndefined();
  });
});
