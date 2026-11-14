/**
 * Shell runtime: the saved windowsShell value, WSL used only on Windows, and the native fallback
 * (with its reason) when WSL is configured but can't be used
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WslAvailability } from '../../../shared/types/settings';
import type { WslProbeResult } from '../wsl-detect';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../index', () => ({ isWindows: () => platform.windows }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const detect = vi.hoisted(() => ({ checkWslAvailable: vi.fn(), probeWsl: vi.fn() }));
vi.mock('../wsl-detect', () => detect);

import {
  getSessionWslInfo,
  getShellRuntimeStatus,
  getWslInfo,
  initShellRuntime,
  isWslRuntime,
  normalizeWindowsShell,
  refreshWslAvailability,
  resetShellRuntimeForTests,
  runInSessionRuntime,
  runNatively,
  runtimeUsesPosixShell,
  toHostPath,
  toRuntimePath,
  whenShellRuntimeReady
} from '../shell-runtime';

const available: WslAvailability = {
  available: true,
  distros: ['Ubuntu'],
  defaultDistro: 'Ubuntu',
  version: 2,
  checkedAt: 1
};

const probe: WslProbeResult = {
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/bin/bash',
  loginPath: '/usr/bin:/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: {
    claude: { path: '/home/me/.local/bin/claude', version: '2.1.3' },
    git: { path: '/usr/bin/git', version: '2.43.0' },
    gh: { path: null, version: null },
    glab: { path: null, version: null },
    python3: { path: '/usr/bin/python3', version: '3.12.3' },
    node: { path: null, version: null },
    npx: { path: null, version: null },
    graphify: { path: null, version: null }
  }
};

describe('shell runtime', () => {
  beforeEach(() => {
    platform.windows = true;
    resetShellRuntimeForTests();
    detect.checkWslAvailable.mockReset().mockResolvedValue(available);
    detect.probeWsl.mockReset().mockResolvedValue(probe);
  });

  it('treats undefined and unknown values as pwsh', () => {
    expect(normalizeWindowsShell(undefined)).toBe('pwsh');
    expect(normalizeWindowsShell('cmd')).toBe('pwsh');
    expect(normalizeWindowsShell('wsl')).toBe('wsl');
  });

  it('is native before init', async () => {
    expect(isWslRuntime()).toBe(false);
    expect(toRuntimePath('C:\\repo')).toBe('C:\\repo');
    expect(runtimeUsesPosixShell()).toBe(false);
    expect(await whenShellRuntimeReady()).toMatchObject({ ready: false, configured: 'pwsh', active: 'pwsh' });
  });

  it('runs natively with pwsh (and an undefined setting) without checking WSL', async () => {
    const status = await initShellRuntime(undefined);
    expect(status).toMatchObject({ supported: true, ready: true, configured: 'pwsh', active: 'pwsh', wsl: null });
    expect(detect.checkWslAvailable).not.toHaveBeenCalled();
    expect(isWslRuntime()).toBe(false);
    expect(getWslInfo()).toBeNull();
  });

  it('runs natively inside runNatively(), also in what it awaits, while the session stays in WSL', async () => {
    await initShellRuntime('wsl');
    const inside = await runNatively(async () => {
      await Promise.resolve();
      return { wsl: isWslRuntime(), info: getWslInfo(), session: getSessionWslInfo()?.distro, path: toRuntimePath('C:\\repo') };
    });
    expect(inside).toEqual({ wsl: false, info: null, session: 'Ubuntu', path: 'C:\\repo' });
    // Back in the session's runtime from inside it
    expect(runNatively(() => runInSessionRuntime(() => isWslRuntime()))).toBe(true);
    expect(isWslRuntime()).toBe(true);
    expect(toRuntimePath('C:\\repo')).toBe('/mnt/c/repo');
  });

  it('runs in WSL when configured and available', async () => {
    const status = await initShellRuntime('wsl');
    expect(status).toMatchObject({ configured: 'wsl', active: 'wsl', distro: 'Ubuntu', wsl: available });
    expect(detect.probeWsl).toHaveBeenCalledWith('Ubuntu');
    expect(isWslRuntime()).toBe(true);
    expect(getWslInfo()?.home).toBe('/home/me');
    expect(runtimeUsesPosixShell()).toBe(true);
    expect(toRuntimePath('C:\\Users\\me\\repo')).toBe('/mnt/c/Users/me/repo');
    expect(toHostPath('/home/me/repo')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    expect(toHostPath('/mnt/c/repo')).toBe('C:\\repo');
    // A path the distribution can't reach stays as it is
    expect(toRuntimePath('\\\\wsl.localhost\\Debian\\x')).toBe('\\\\wsl.localhost\\Debian\\x');
  });

  it('ignores wsl off Windows', async () => {
    platform.windows = false;
    const status = await initShellRuntime('wsl');
    expect(status).toMatchObject({ supported: false, active: 'pwsh' });
    expect(detect.checkWslAvailable).not.toHaveBeenCalled();
    expect(isWslRuntime()).toBe(false);
    expect(runtimeUsesPosixShell()).toBe(true);
    expect(toRuntimePath('/home/me')).toBe('/home/me');
  });

  it('falls back to native with the reason when WSL is unavailable', async () => {
    detect.checkWslAvailable.mockResolvedValue({ available: false, reason: 'no-distro', distros: [], checkedAt: 1 });
    const status = await initShellRuntime('wsl');
    expect(status).toMatchObject({
      configured: 'wsl',
      active: 'pwsh',
      fallbackReason: 'wsl-unavailable',
      fallbackDetail: 'no-distro'
    });
    expect(detect.probeWsl).not.toHaveBeenCalled();
    expect(isWslRuntime()).toBe(false);
  });

  it('falls back to native when the probe fails', async () => {
    detect.probeWsl.mockRejectedValue(new Error('The WSL probe of Ubuntu timed out'));
    const status = await initShellRuntime('wsl');
    expect(status).toMatchObject({
      active: 'pwsh',
      fallbackReason: 'probe-failed',
      fallbackDetail: 'The WSL probe of Ubuntu timed out'
    });
    expect(isWslRuntime()).toBe(false);
    expect(toRuntimePath('C:\\repo')).toBe('C:\\repo');
  });

  it('keeps the first init and is ready afterwards', async () => {
    const first = initShellRuntime('wsl');
    expect(initShellRuntime('pwsh')).toBe(first);
    await first;
    expect((await whenShellRuntimeReady()).active).toBe('wsl');
  });

  it('refreshes WSL availability without changing the runtime', async () => {
    await initShellRuntime('pwsh');
    const status = await refreshWslAvailability();
    expect(detect.checkWslAvailable).toHaveBeenCalledWith({ refresh: true });
    expect(status).toMatchObject({ active: 'pwsh', wsl: available });
    expect(getShellRuntimeStatus().wsl).toEqual(available);
  });
});
