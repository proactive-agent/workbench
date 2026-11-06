/**
 * @vitest-environment jsdom
 */
/**
 * The Playwright browser picker keeps the stored choice's paths in step with detection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import '../../../../shared/i18n';
import { PlaywrightBrowserSelect } from '../PlaywrightBrowserSelect';
import { toBrowserChoice } from '../browser-profile-meta';
import type { BrowserProfile } from '../../../../shared/types/browser-profiles';

const firefox: BrowserProfile = {
  id: 'playwright:firefox',
  browser: 'firefox',
  engine: 'firefox',
  profileName: 'Firefox',
  managed: true,
  userDataDir: '',
  profilePath: '',
  executablePath: '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox',
  usable: true,
};

describe('PlaywrightBrowserSelect', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      detectBrowserProfiles: vi.fn(async () => ({ success: true, data: [firefox] })),
      onBrowserProfilesChanged: vi.fn(() => () => undefined),
      installPlaywrightBrowser: vi.fn(async () => undefined),
    };
  });

  it('takes the detected paths when the stored choice is out of date', async () => {
    const stale = { ...toBrowserChoice(firefox)!, executablePath: '/home/me/.cache/ms-playwright/firefox-1495/firefox/firefox' };
    const onChange = vi.fn();
    render(<PlaywrightBrowserSelect value={stale} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(toBrowserChoice(firefox)));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves an up-to-date choice alone', async () => {
    const onChange = vi.fn();
    render(<PlaywrightBrowserSelect value={toBrowserChoice(firefox)} onChange={onChange} />);
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
    const { findByText } = render(<PlaywrightBrowserSelect value={stored} onChange={onChange} />);
    expect(await findByText(/Work \(no longer found\)/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables a download button while its download runs, until Chromium is no longer missing', async () => {
    const install = vi.fn(async () => ({ success: true, data: { command: 'npx -y @playwright/mcp@0.0.83 install-browser chromium' } }));
    (window.electronAPI as unknown as { installPlaywrightBrowser: unknown }).installPlaywrightBrowser = install;
    const { getByRole, findByRole, rerender } = render(<PlaywrightBrowserSelect value={undefined} onChange={vi.fn()} chromiumMissing />);
    await waitFor(() => expect(window.electronAPI.detectBrowserProfiles).toHaveBeenCalled());
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    const button = await findByRole('button', { name: /^Download Chromium/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(getByRole('button', { name: /Downloading Chromium/ })).toHaveProperty('disabled', true));
    fireEvent.click(getByRole('button', { name: /Downloading Chromium/ }));
    expect(install).toHaveBeenCalledTimes(1);

    // Downloaded (Playwright checked again): the next time Chromium is missing, it can be downloaded again
    rerender(<PlaywrightBrowserSelect value={undefined} onChange={vi.fn()} chromiumMissing={false} />);
    rerender(<PlaywrightBrowserSelect value={undefined} onChange={vi.fn()} chromiumMissing />);
    expect((await findByRole('button', { name: /^Download Chromium/ })).hasAttribute('disabled')).toBe(false);
  });

  it('enables the button again when the download could not start', async () => {
    const install = vi.fn(async () => ({ success: false, error: 'npx was not found' }));
    (window.electronAPI as unknown as { installPlaywrightBrowser: unknown }).installPlaywrightBrowser = install;
    const { getByRole, findByRole, findByText } = render(<PlaywrightBrowserSelect value={undefined} onChange={vi.fn()} chromiumMissing />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await findByRole('button', { name: /^Download Chromium/ }));
    expect(await findByText('npx was not found')).toBeTruthy();
    expect((await findByRole('button', { name: /^Download Chromium/ })).hasAttribute('disabled')).toBe(false);
  });

  it('says a download already runs in a terminal, without a waiting pulse, when the main process started none', async () => {
    const install = vi.fn(async () => ({ success: true, data: { command: 'npx -y @playwright/mcp@0.0.83 install-browser chromium', alreadyRunning: true } }));
    (window.electronAPI as unknown as { installPlaywrightBrowser: unknown }).installPlaywrightBrowser = install;
    const { getByRole, findByRole, findByText } = render(<PlaywrightBrowserSelect value={undefined} onChange={vi.fn()} chromiumMissing />);
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await findByRole('button', { name: /^Download Chromium/ }));
    expect(await findByText('Already downloading Chromium in a terminal')).toBeTruthy();
    expect((await findByRole('button', { name: /^Download Chromium/ })).hasAttribute('disabled')).toBe(false);
  });
});
