import { describe, it, expect, vi } from 'vitest';

const wsl = vi.hoisted(() => ({ info: null as null | { distro: string } }));
vi.mock('../../platform/shell-runtime', () => ({ getWslInfo: () => wsl.info }));
vi.mock('electron', () => ({ app: { getPath: () => '/data' } }));

import { isWindowsBrowserInWsl } from '../windows-browser';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

const choice = (patch: Partial<PlaywrightBrowserChoice>): PlaywrightBrowserChoice => ({
  id: 'windows-edge:Default',
  browser: 'edge',
  engine: 'chromium',
  profileName: 'Default',
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
  profilePath: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default',
  ...patch,
});

describe('isWindowsBrowserInWsl', () => {
  it('takes Windows Chromium browsers while tools run in WSL', () => {
    wsl.info = { distro: 'Ubuntu' };
    expect(isWindowsBrowserInWsl(choice({}))).toBe(true);
  });

  it("leaves out native runs, WSL's own browsers, Firefox and Playwright's downloads", () => {
    wsl.info = null;
    expect(isWindowsBrowserInWsl(choice({}))).toBe(false);
    wsl.info = { distro: 'Ubuntu' };
    expect(isWindowsBrowserInWsl(choice({ executablePath: '/usr/bin/microsoft-edge' }))).toBe(false);
    // A Windows Firefox profile runs on a Firefox in WSL (its Linux executable)
    expect(isWindowsBrowserInWsl(choice({ engine: 'firefox', browser: 'firefox', executablePath: '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox' }))).toBe(false);
    expect(isWindowsBrowserInWsl(choice({ managed: true }))).toBe(false);
    expect(isWindowsBrowserInWsl(undefined)).toBe(false);
  });
});
