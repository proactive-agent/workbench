import { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { SettingsRow, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { Button } from '../ui/button';
import { saveSettings } from '../../stores/settings-store';
import { isWindows } from '../../lib/os-detection';
import { cn } from '../../lib/utils';
import { SettingsFlushContext } from './settings-flush';
import type { AppSettings, ChatBrowserRuntimeStatus, WindowsShell } from '../../../shared/types';

interface BrowserRuntimeRowProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Browser runtime (Settings > Browser, Windows only): where chat browsers run while the shell is
 * WSL. PowerShell runs them on Windows (browser-drawer/browser-runtime.ts in the main process),
 * which needs Node.js there: without it the option is off and Autoconfigure installs what is
 * missing in a PowerShell window. WSL runs them in the distribution, only with the WSL shell. The
 * app decides at startup, so a changed value offers a restart, as the Shell row does.
 */
export function BrowserRuntimeRow({ settings, onSettingsChange }: BrowserRuntimeRowProps) {
  const { t } = useTranslation('settings');
  const onWindows = isWindows();
  // Kept in memory by the main process (checked at startup): read once, checked again on request
  const [status, setStatus] = useState<ChatBrowserRuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const flushDialogSave = useContext(SettingsFlushContext);

  useEffect(() => {
    if (!onWindows) return;
    let cancelled = false;
    void window.electronAPI.getChatBrowserRuntimeStatus().then((result) => {
      if (!cancelled && result.success && result.data) setStatus(result.data);
    });
    const cleanup = window.electronAPI.onChatBrowserRuntimeStatus((next) => setStatus(next));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [onWindows]);

  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.electronAPI.getChatBrowserRuntimeStatus(true);
      if (result.success && result.data) setStatus(result.data);
    } finally {
      setChecking(false);
    }
  }, []);

  const autoconfigure = async () => {
    setError(null);
    const result = await window.electronAPI.autoconfigureChatBrowserRuntime();
    if (result.success && result.data) setStatus(result.data);
    else setError(result.error ?? t('browser.runtime.autoconfigureFailed'));
  };

  if (!onWindows || !status) return null;

  const shell: WindowsShell = settings.windowsShell ?? 'pwsh';
  const value: WindowsShell = settings.browser?.windowsRuntime ?? shell;
  // Running them on Windows only matters with the WSL shell (they do with PowerShell anyway)
  const missing = status.wslShell ? status.missing : [];
  // What Autoconfigure installs (interop and the default profile are the user's to change)
  const canFix = missing.some((requirement) => requirement === 'node' || requirement === 'browserBuild');

  const options: SegmentedOption<WindowsShell>[] = [
    { value: 'pwsh', label: t('browser.runtime.pwsh'), disabled: missing.length > 0 },
    { value: 'wsl', label: t('browser.runtime.wsl'), disabled: !status.wslShell },
  ];

  const handleChange = (windowsRuntime: WindowsShell) => {
    onSettingsChange({ ...settings, browser: { ...settings.browser, windowsRuntime } });
  };

  // The saved value differs from where this session's chat browsers run, and could apply
  const needsRestart = status.wslShell && value !== status.active && (value !== 'pwsh' || missing.length === 0);
  const persistPending = flushDialogSave ?? (() => saveSettings({ browser: { ...settings.browser, windowsRuntime: value } }));
  const restart = async () => {
    setRestarting(true);
    if (await persistPending()) {
      await window.electronAPI.relaunchApp();
      return;
    }
    setRestarting(false);
  };

  const notes: string[] = [];
  if (!status.wslShell) notes.push(t('browser.runtime.pwshShell'));
  for (const requirement of missing) notes.push(t(`browser.runtime.missing.${requirement}`));
  if (status.configuring) notes.push(t('browser.runtime.configuring'));
  if (error) notes.push(error);

  return (
    <SettingsRow
      label={t('browser.runtime.label')}
      description={
        <span className="flex flex-col gap-1">
          <span>{t('browser.runtime.description')}</span>
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      }
    >
      {missing.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 px-0"
          onClick={() => void checkAgain()}
          disabled={checking || status.configuring}
          aria-label={t('browser.runtime.checkAgain')}
          title={t('browser.runtime.checkAgain')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        </Button>
      )}
      {canFix && (
        <Button variant="outline" size="sm" disabled={status.configuring} onClick={() => void autoconfigure()}>
          {t('browser.runtime.autoconfigure')}
        </Button>
      )}
      {needsRestart && (
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>
          {t('browser.runtime.restartToApply')}
        </Button>
      )}
      <SegmentedControl value={value} options={options} onValueChange={handleChange} ariaLabel={t('browser.runtime.label')} />
    </SettingsRow>
  );
}
