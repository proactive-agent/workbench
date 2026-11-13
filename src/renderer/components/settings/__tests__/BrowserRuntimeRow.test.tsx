/**
 * @vitest-environment jsdom
 */
/**
 * Browser runtime (Settings > Browser, Windows): where chat browsers run while the shell is WSL.
 * PWSH is off while running them on Windows needs something, with Autoconfigure to install it;
 * WSL is off without the WSL shell; a changed value offers a restart
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import type { AppSettings, ChatBrowserRuntimeStatus } from '../../../../shared/types';

vi.mock('../../../lib/os-detection', () => ({ isWindows: () => true }));
vi.mock('../../../stores/settings-store', () => ({ saveSettings: vi.fn(async () => true) }));

import { BrowserRuntimeRow } from '../BrowserRuntimeRow';

let statusListener: ((status: ChatBrowserRuntimeStatus) => void) | null = null;
const api = {
  getChatBrowserRuntimeStatus: vi.fn(),
  autoconfigureChatBrowserRuntime: vi.fn(),
  onChatBrowserRuntimeStatus: vi.fn((listener: (status: ChatBrowserRuntimeStatus) => void) => {
    statusListener = listener;
    return () => undefined;
  }),
  relaunchApp: vi.fn(),
};

const wslStatus = (patch: Partial<ChatBrowserRuntimeStatus> = {}): ChatBrowserRuntimeStatus => ({
  active: 'wsl',
  wslShell: true,
  missing: [],
  ...patch,
});

async function renderRow(settings: Partial<AppSettings>, status: ChatBrowserRuntimeStatus) {
  api.getChatBrowserRuntimeStatus.mockResolvedValue({ success: true, data: status });
  const onSettingsChange = vi.fn();
  await act(async () => {
    render(<BrowserRuntimeRow settings={settings as AppSettings} onSettingsChange={onSettingsChange} />);
  });
  return { onSettingsChange };
}

describe('BrowserRuntimeRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusListener = null;
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  });

  it('runs them on Windows when picked, and offers a restart to apply', async () => {
    const { onSettingsChange } = await renderRow({ windowsShell: 'wsl' }, wslStatus());
    fireEvent.click(screen.getByRole('radio', { name: 'PWSH' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ windowsShell: 'wsl', browser: { windowsRuntime: 'pwsh' } });
    // Not picked yet: this session already runs them where the setting says
    expect(screen.queryByRole('button', { name: 'Restart to apply' })).not.toBeInTheDocument();
  });

  it('offers a restart when the saved value differs from where they run', async () => {
    await renderRow({ windowsShell: 'wsl', browser: { windowsRuntime: 'pwsh' } }, wslStatus());
    expect(screen.getByRole('button', { name: 'Restart to apply' })).toBeInTheDocument();
  });

  it("turns PWSH off while Windows lacks what it needs, autoconfigures it and takes the new status", async () => {
    await renderRow({ windowsShell: 'wsl' }, wslStatus({ missing: ['node', 'browserBuild'] }));
    expect(screen.getByRole('radio', { name: 'PWSH' })).toBeDisabled();
    expect(screen.getByText('Running them on Windows needs Node.js 20 or newer there')).toBeInTheDocument();

    api.autoconfigureChatBrowserRuntime.mockResolvedValue({ success: true, data: wslStatus({ missing: ['node', 'browserBuild'], configuring: true }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Autoconfigure' }));
    });
    expect(api.autoconfigureChatBrowserRuntime).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Autoconfigure' })).toBeDisabled();
    expect(screen.getByText('Setting up in PowerShell...')).toBeInTheDocument();

    // The PowerShell window closed with everything installed
    act(() => statusListener?.(wslStatus()));
    expect(screen.getByRole('radio', { name: 'PWSH' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Autoconfigure' })).not.toBeInTheDocument();
  });

  it("can't autoconfigure WSL's interop, and has no WSL option without the WSL shell", async () => {
    await renderRow({ windowsShell: 'wsl' }, wslStatus({ missing: ['interop'] }));
    expect(screen.queryByRole('button', { name: 'Autoconfigure' })).not.toBeInTheDocument();
    expect(screen.getByText("WSL interop is off, so Claude Code can't reach browsers on Windows")).toBeInTheDocument();
  });

  it('shows PWSH with the PowerShell shell, WSL off', async () => {
    await renderRow({}, { active: 'pwsh', wslShell: false, missing: ['node'] });
    expect(screen.getByRole('radio', { name: 'PWSH' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'WSL' })).toBeDisabled();
    // What Windows lacks doesn't matter with the PowerShell shell
    expect(screen.queryByRole('button', { name: 'Autoconfigure' })).not.toBeInTheDocument();
  });
});
