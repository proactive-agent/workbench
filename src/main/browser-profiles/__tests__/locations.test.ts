import { describe, it, expect } from 'vitest';
import { browserLocations } from '../locations';

const find = (locations: ReturnType<typeof browserLocations>, browser: string, variant?: string) =>
  locations.find((l) => l.browser === browser && l.variant === variant);

describe('browserLocations', () => {
  it('uses LOCALAPPDATA, APPDATA and Program Files on Windows', () => {
    const locations = browserLocations('windows', {
      home: 'C:\\Users\\me',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files' },
    });
    expect(find(locations, 'chrome')).toMatchObject({
      engine: 'chromium',
      dataDirs: ['C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data'],
      executables: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      ],
    });
    expect(find(locations, 'edge')?.dataDirs).toEqual(['C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data']);
    expect(find(locations, 'brave')?.executables[0]).toBe('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
    expect(find(locations, 'firefox')).toMatchObject({
      engine: 'firefox',
      dataDirs: ['C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox'],
      executables: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
        'C:\\Users\\me\\AppData\\Local\\Mozilla Firefox\\firefox.exe',
      ],
    });
    expect(find(locations, 'safari')).toBeUndefined();
  });

  it('falls back to the home folder when the environment has no folders (Windows)', () => {
    const locations = browserLocations('windows', { home: 'C:\\Users\\me', env: {} });
    expect(find(locations, 'chromium')?.dataDirs).toEqual(['C:\\Users\\me\\AppData\\Local\\Chromium\\User Data']);
  });

  it('uses Application Support and app bundles on macOS, with Safari unsupported', () => {
    const locations = browserLocations('macos', { home: '/Users/me', env: {} });
    expect(find(locations, 'chrome')).toMatchObject({
      dataDirs: ['/Users/me/Library/Application Support/Google/Chrome'],
      executables: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
    });
    expect(find(locations, 'firefox')?.dataDirs).toEqual(['/Users/me/Library/Application Support/Firefox']);
    expect(find(locations, 'safari')).toMatchObject({ engine: 'webkit', disabledReason: 'unsupported-engine' });
  });

  it('covers distribution packages, snaps and Flatpaks on Linux', () => {
    const locations = browserLocations('linux', { home: '/home/me', env: {} });
    expect(find(locations, 'chrome')).toMatchObject({
      dataDirs: ['/home/me/.config/google-chrome'],
      executables: ['/opt/google/chrome/chrome'],
      commands: ['google-chrome-stable', 'google-chrome'],
    });
    expect(find(locations, 'chromium', 'snap')).toMatchObject({
      dataDirs: ['/home/me/snap/chromium/common/chromium'],
      executables: ['/snap/bin/chromium'],
    });
    expect(find(locations, 'firefox')).toMatchObject({
      dataDirs: ['/home/me/.mozilla/firefox', '/home/me/.config/mozilla/firefox'],
      commands: ['firefox', 'firefox-esr'],
    });
    expect(find(locations, 'firefox')?.executables).toContain('/usr/lib/firefox-esr/firefox-esr');
    expect(find(locations, 'firefox', 'snap')?.dataDirs).toEqual(['/home/me/snap/firefox/common/.mozilla/firefox']);
    expect(find(locations, 'chrome', 'flatpak')).toMatchObject({
      dataDirs: ['/home/me/.var/app/com.google.Chrome/config/google-chrome'],
      disabledReason: 'sandboxed-package',
    });
    expect(find(locations, 'safari')).toBeUndefined();
  });

  it('honors an absolute XDG_CONFIG_HOME on Linux', () => {
    const locations = browserLocations('linux', { home: '/home/me', env: { XDG_CONFIG_HOME: '/data/config' } });
    expect(find(locations, 'chrome')?.dataDirs).toEqual(['/data/config/google-chrome']);
    expect(find(locations, 'brave')?.dataDirs).toEqual(['/data/config/BraveSoftware/Brave-Browser']);
    expect(find(locations, 'firefox')?.dataDirs).toEqual(['/home/me/.mozilla/firefox', '/data/config/mozilla/firefox']);
    // Relative: invalid, ignored
    const relative = browserLocations('linux', { home: '/home/me', env: { XDG_CONFIG_HOME: 'config' } });
    expect(find(relative, 'chrome')?.dataDirs).toEqual(['/home/me/.config/google-chrome']);
  });
});
