/**
 * @vitest-environment jsdom
 */
/**
 * The Puppeteer browser picker keeps the stored choice's paths in step with detection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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

  it('disables a download button while its download runs, until Chrome is no longer missing', async () => {
    const install = vi.fn(async () => ({ success: true, data: { command: 'npx puppeteer browsers install chrome' } }));
    (window.electronAPI as unknown as { installPuppeteerBrowser: unknown }).installPuppeteerBrowser = install;
    const { getByRole, findByRole, rerender } = render(<PuppeteerBrowserSelect value={undefined} onChange={vi.fn()} chromeMissing />);
    await waitFor(() => expect(window.electronAPI.detectBrowserProfiles).toHaveBeenCalled());
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    const button = await findByRole('button', { name: /^Download Chrome/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(getByRole('button', { name: /Downloading Chrome/ })).toHaveProperty('disabled', true));
    fireEvent.click(getByRole('button', { name: /Downloading Chrome/ }));
    expect(install).toHaveBeenCalledTimes(1);

    // Downloaded (Puppeteer checked again): the next time Chrome is missing, it can be downloaded again
    rerender(<PuppeteerBrowserSelect value={undefined} onChange={vi.fn()} chromeMissing={false} />);
    rerender(<PuppeteerBrowserSelect value={undefined} onChange={vi.fn()} chromeMissing />);
    expect((await findByRole('button', { name: /^Download Chrome/ })).hasAttribute('disabled')).toBe(false);
  });

  it('enables the button again when the download could not start', async () => {
    const install = vi.fn(async () => ({ success: false, error: 'npx was not found' }));
    (window.electronAPI as unknown as { installPuppeteerBrowser: unknown }).installPuppeteerBrowser = install;
    const { getByRole, findByRole, findByText } = render(<PuppeteerBrowserSelect value={undefined} onChange={vi.fn()} chromeMissing />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await findByRole('button', { name: /^Download Chrome/ }));
    expect(await findByText('npx was not found')).toBeTruthy();
    expect((await findByRole('button', { name: /^Download Chrome/ })).hasAttribute('disabled')).toBe(false);
  });

  it('says a download already runs in a terminal, without a waiting pulse, when the main process started none', async () => {
    const install = vi.fn(async () => ({ success: true, data: { command: 'npx puppeteer browsers install chrome', alreadyRunning: true } }));
    (window.electronAPI as unknown as { installPuppeteerBrowser: unknown }).installPuppeteerBrowser = install;
    const { getByRole, findByRole, findByText } = render(<PuppeteerBrowserSelect value={undefined} onChange={vi.fn()} chromeMissing />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await findByRole('button', { name: /^Download Chrome/ }));
    expect(await findByText('Already downloading Chrome in a terminal')).toBeTruthy();
    expect((await findByRole('button', { name: /^Download Chrome/ })).hasAttribute('disabled')).toBe(false);
  });
});
