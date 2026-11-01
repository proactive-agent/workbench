/**
 * @vitest-environment jsdom
 */
/**
 * The Puppeteer browser picker keeps the stored choice's paths in step with detection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '../../../../shared/i18n';
import { PuppeteerBrowserSelect } from '../PuppeteerBrowserSelect';
import { toBrowserChoice } from '../browser-profile-meta';
import type { BrowserProfile } from '../../../../shared/types/browser-profiles';

const firefox: BrowserProfile = {
  id: 'puppeteer:firefox',
  browser: 'firefox',
  engine: 'firefox',
  profileName: 'Firefox',
  managed: true,
  userDataDir: '/home/me/.cache/puppeteer/firefox',
  profilePath: '/home/me/.cache/puppeteer/firefox',
  executablePath: '/home/me/.cache/puppeteer/firefox/linux-stable_158.0.1/firefox/firefox',
  usable: true,
};

describe('PuppeteerBrowserSelect', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      detectBrowserProfiles: vi.fn(async () => ({ success: true, data: [firefox] })),
      onBrowserProfilesChanged: vi.fn(() => () => undefined),
      installPuppeteerBrowser: vi.fn(async () => undefined),
    };
  });

  it('takes the detected paths when the stored choice is out of date', async () => {
    const stale = { ...toBrowserChoice(firefox)!, executablePath: '/home/me/.cache/puppeteer/firefox/linux-stable_133.0.3/firefox/firefox' };
    const onChange = vi.fn();
    render(<PuppeteerBrowserSelect value={stale} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(toBrowserChoice(firefox)));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves an up-to-date choice alone', async () => {
    const onChange = vi.fn();
    render(<PuppeteerBrowserSelect value={toBrowserChoice(firefox)} onChange={onChange} />);
    await waitFor(() => expect(window.electronAPI.detectBrowserProfiles).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a choice as not found when only another install's profile has its id", async () => {
    const linuxChrome: BrowserProfile = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Home',
      userDataDir: '/home/me/.config/google-chrome', profileDirectory: 'Default', profilePath: '/home/me/.config/google-chrome/Default',
      executablePath: '/opt/google/chrome/chrome', usable: true,
    };
    vi.mocked(window.electronAPI.detectBrowserProfiles).mockResolvedValue({ success: true, data: [linuxChrome] });
    const stored = toBrowserChoice({
      ...linuxChrome,
      profileName: 'Work',
      userDataDir: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
      profilePath: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    })!;
    const onChange = vi.fn();
    const { findByText } = render(<PuppeteerBrowserSelect value={stored} onChange={onChange} />);
    expect(await findByText(/Work \(no longer found\)/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onChange).not.toHaveBeenCalled();
  });
});
