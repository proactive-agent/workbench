import { describe, it, expect, vi, beforeEach } from 'vitest';

const readlinkSync = vi.fn();
const isWindows = vi.fn(() => true);
vi.mock('fs', () => ({ readlinkSync: (p: string) => readlinkSync(p) }));
vi.mock('../../platform', () => ({ isWindows: () => isWindows() }));

import { appAliasTarget } from '../app-alias';

const ALIAS = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\Mozilla.Firefox_n80bbvh6b1yt2\\firefox.exe';
const TARGET = 'C:\\Program Files\\WindowsApps\\Mozilla.Firefox_158.0.1.0_x64__n80bbvh6b1yt2\\VFS\\ProgramFiles\\Firefox Package Root\\firefox.exe';

describe('appAliasTarget', () => {
  beforeEach(() => {
    readlinkSync.mockReset();
    isWindows.mockReturnValue(true);
  });

  it("runs a Store app's alias as the package executable it points at", () => {
    readlinkSync.mockReturnValue(TARGET);
    expect(appAliasTarget(ALIAS)).toBe(TARGET);
  });

  it('keeps the alias when it cannot be read', () => {
    readlinkSync.mockImplementation(() => {
      throw new Error('EINVAL');
    });
    expect(appAliasTarget(ALIAS)).toBe(ALIAS);
  });

  it('leaves other executables alone', () => {
    expect(appAliasTarget('C:\\Program Files\\Mozilla Firefox\\firefox.exe')).toBe('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
    isWindows.mockReturnValue(false);
    expect(appAliasTarget('/usr/lib/firefox/firefox')).toBe('/usr/lib/firefox/firefox');
    expect(readlinkSync).not.toHaveBeenCalled();
  });
});
