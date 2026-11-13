/**
 * @vitest-environment jsdom
 */
/**
 * Windows shell row (Appearance): PWSH / WSL on Windows only, WSL disabled with the reason when it
 * isn't available, and a restart when the saved value differs from the one the app runs with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { TooltipProvider } from '../../ui/tooltip';
import { WindowsShellSelector } from '../WindowsShellSelector';
import { SettingsFlushProvider } from '../settings-flush';
import type { AppSettings, ShellRuntimeStatus, WslAvailability } from '../../../../shared/types';

// jsdom has no matchMedia or ResizeObserver (used by SegmentedControl)
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../../lib/os-detection', () => ({ isWindows: () => platform.windows }));

const updateSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { updateSettings: typeof updateSettings }) => unknown) =>
    selector({ updateSettings }),
  saveSettings: (updates: unknown) => saveSettings(updates)
}));

const available: WslAvailability = { available: true, distros: ['Ubuntu'], defaultDistro: 'Ubuntu', version: 2, checkedAt: 1 };
const notInstalled: WslAvailability = { available: false, reason: 'not-installed', distros: [], checkedAt: 1 };

const status = (overrides: Partial<ShellRuntimeStatus> = {}): ShellRuntimeStatus => ({
  supported: true,
  ready: true,
  configured: 'pwsh',
  active: 'pwsh',
  wsl: null,
  ...overrides
});

const api = {
  getShellRuntimeStatus: vi.fn(),
  refreshWslAvailability: vi.fn(),
  relaunchApp: vi.fn()
};

const renderRow = (settings: Partial<AppSettings>, onSettingsChange = vi.fn()) => {
  const result = render(
    <TooltipProvider>
      <WindowsShellSelector settings={settings as AppSettings} onSettingsChange={onSettingsChange} />
    </TooltipProvider>
  );
  return { ...result, onSettingsChange };
};

describe('WindowsShellSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    platform.windows = true;
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
    api.getShellRuntimeStatus.mockResolvedValue({ success: true, data: status() });
    api.refreshWslAvailability.mockResolvedValue({ success: true, data: status({ wsl: available }) });
    api.relaunchApp.mockResolvedValue({ success: true });
    saveSettings.mockResolvedValue(true);
  });

  it('is hidden off Windows', () => {
    platform.windows = false;
    const { container } = renderRow({ theme: 'dark' });
    expect(container).toBeEmptyDOMElement();
    expect(api.getShellRuntimeStatus).not.toHaveBeenCalled();
  });

  it('shows PWSH by default and checks WSL once when nothing was checked', async () => {
    renderRow({ theme: 'dark' });
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'PWSH' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled());
    expect(api.refreshWslAvailability).toHaveBeenCalledTimes(1);
  });

  it('uses the last check instead of checking again', async () => {
    localStorage.setItem('refresh-cache:wsl-availability', JSON.stringify(available));
    renderRow({ theme: 'dark' });
    await waitFor(() => expect(api.getShellRuntimeStatus).toHaveBeenCalled());
    expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled();
    expect(api.refreshWslAvailability).not.toHaveBeenCalled();
  });

  it('disables WSL and states why when it is not available', async () => {
    api.refreshWslAvailability.mockResolvedValue({ success: true, data: status({ wsl: notInstalled }) });
    renderRow({ theme: 'dark' });
    expect(await screen.findByText('WSL is not installed')).toBeInTheDocument();
    const wsl = screen.getByRole('radio', { name: 'WSL' });
    expect(wsl).toBeDisabled();
    fireEvent.click(wsl);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('saves WSL and offers a restart when it differs from the running value', async () => {
    const { onSettingsChange, rerender } = renderRow({ theme: 'dark' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Restart to apply' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'WSL' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ theme: 'dark', windowsShell: 'wsl' });
    expect(updateSettings).toHaveBeenCalledWith({ windowsShell: 'wsl' });

    rerender(
      <TooltipProvider>
        <WindowsShellSelector settings={{ theme: 'dark', windowsShell: 'wsl' } as AppSettings} onSettingsChange={onSettingsChange} />
      </TooltipProvider>
    );
    // The dialog only saves after a pause, so the row saves the shell itself and waits for it:
    // relaunching first would start the app on the shell it already ran with
    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith({ windowsShell: 'wsl' });
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.relaunchApp.mock.invocationCallOrder[0]
    );
  });

  it('does not restart when the shell could not be saved', async () => {
    saveSettings.mockResolvedValue(false);
    const { onSettingsChange } = renderRow({ theme: 'dark', windowsShell: 'wsl' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ windowsShell: 'wsl' }));
    expect(api.relaunchApp).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("saves the dialog's pending edits, not just the shell, before it restarts", async () => {
    // What the dialog's flush does: it writes the whole settings object, so the theme the user
    // picked a moment ago goes to disk too instead of dying with the debounce the relaunch kills
    const flush = vi.fn(() => saveSettings({ theme: 'light', windowsShell: 'wsl' }));
    render(
      <TooltipProvider>
        <SettingsFlushProvider value={flush}>
          <WindowsShellSelector
            settings={{ theme: 'light', windowsShell: 'wsl' } as AppSettings}
            onSettingsChange={vi.fn()}
          />
        </SettingsFlushProvider>
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));

    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ theme: 'light', windowsShell: 'wsl' });
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.relaunchApp.mock.invocationCallOrder[0]
    );
  });

  it('does not restart when the dialog could not save what was pending', async () => {
    const flush = vi.fn(async () => false);
    render(
      <TooltipProvider>
        <SettingsFlushProvider value={flush}>
          <WindowsShellSelector
            settings={{ theme: 'light', windowsShell: 'wsl' } as AppSettings}
            onSettingsChange={vi.fn()}
          />
        </SettingsFlushProvider>
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));

    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(api.relaunchApp).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('offers no restart when the saved value is the running one', async () => {
    api.getShellRuntimeStatus.mockResolvedValue({
      success: true,
      data: status({ configured: 'wsl', active: 'wsl', wsl: available, distro: 'Ubuntu' })
    });
    renderRow({ theme: 'dark', windowsShell: 'wsl' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'WSL' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByRole('button', { name: 'Restart to apply' })).not.toBeInTheDocument();
    expect(api.refreshWslAvailability).not.toHaveBeenCalled();
  });

  it('says when the session fell back to PWSH', async () => {
    api.getShellRuntimeStatus.mockResolvedValue({
      success: true,
      data: status({ configured: 'wsl', active: 'pwsh', wsl: notInstalled, fallbackReason: 'wsl-unavailable' })
    });
    renderRow({ theme: 'dark', windowsShell: 'wsl' });
    expect(await screen.findByText('WSL could not start, so this session uses PWSH')).toBeInTheDocument();
    // WSL can't be applied, so no restart
    expect(screen.queryByRole('button', { name: 'Restart to apply' })).not.toBeInTheDocument();
  });
});
