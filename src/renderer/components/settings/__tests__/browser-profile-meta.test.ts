import { describe, it, expect } from 'vitest';
import { browserProfileLabel, disabledReasonText, toBrowserChoice } from '../browser-profile-meta';
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

  it('gives each disabled reason as text', () => {
    expect(disabledReasonText(t, 'unsupported-engine')).toBe('unsupportedEngine');
    expect(disabledReasonText(t, 'windows-browser-in-wsl')).toBe('windowsBrowserInWsl');
    expect(disabledReasonText(t, undefined)).toBeUndefined();
  });
});
