import { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { SettingsRow, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { Button } from '../ui/button';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { isWindows } from '../../lib/os-detection';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { cn } from '../../lib/utils';
import { SettingsFlushContext } from './settings-flush';
import type { AppSettings, ShellRuntimeStatus, WindowsShell, WslAvailability } from '../../../shared/types';

interface WindowsShellSelectorProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const WSL_CACHE_KEY = 'wsl-availability';

/**
 * Windows shell row (Appearance, Windows only): PWSH runs native tools, WSL runs everything in
 * WSL's default distribution. WSL can't be picked when it isn't available (the reason is stated).
 * The app reads the setting at startup, so a changed value offers a restart.
 */
export function WindowsShellSelector({ settings, onSettingsChange }: WindowsShellSelectorProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);
  const onWindows = isWindows();
  const [status, setStatus] = useState<ShellRuntimeStatus | null>(null);
  const [availability, setAvailability] = useState<WslAvailability | null>(() =>
    onWindows ? readRefreshCache<WslAvailability>(WSL_CACHE_KEY) ?? null : null
  );
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const flushDialogSave = useContext(SettingsFlushContext);

  const checkWsl = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.electronAPI.refreshWslAvailability();
      if (result.success && result.data) {
        setStatus(result.data);
        if (result.data.wsl) {
          setAvailability(result.data.wsl);
          writeRefreshCache(WSL_CACHE_KEY, result.data.wsl);
        }
      }
    } finally {
      setChecking(false);
    }
  }, []);

  // The runtime status is in memory in the main process; WSL is only checked when nothing was
  // checked before (or on Check again)
  useEffect(() => {
    if (!onWindows) return;
    let cancelled = false;
    void window.electronAPI.getShellRuntimeStatus().then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setStatus(result.data);
      const cached = readRefreshCache<WslAvailability>(WSL_CACHE_KEY);
      const fromMain = result.data.wsl;
      if (fromMain && (!cached || fromMain.checkedAt >= cached.checkedAt)) {
        setAvailability(fromMain);
        writeRefreshCache(WSL_CACHE_KEY, fromMain);
      } else if (!cached) {
        void checkWsl();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onWindows, checkWsl]);

  if (!onWindows) return null;

  const value: WindowsShell = settings.windowsShell ?? 'pwsh';
  const wslAvailable = availability?.available === true;

  const handleChange = (windowsShell: WindowsShell) => {
    onSettingsChange({ ...settings, windowsShell });
    updateStoreSettings({ windowsShell });
  };

  // The dialog saves what the user changed after a short pause, so the restart has to get it all
  // on disk first: relaunching before that save lands starts the app on the old shell, and takes
  // every other pending edit with it. Outside the dialog there is nothing else pending, so this
  // row's own value is the whole change. A failed save leaves the app running.
  const persistPending = flushDialogSave ?? (() => saveSettings({ windowsShell: value }));

  const restart = async () => {
    setRestarting(true);
    if (await persistPending()) {
      await window.electronAPI.relaunchApp();
      return;
    }
    setRestarting(false);
  };

  const options: SegmentedOption<WindowsShell>[] = [
    { value: 'pwsh', label: t('theme.windowsShellPwsh') },
    { value: 'wsl', label: t('theme.windowsShellWsl'), disabled: !wslAvailable }
  ];

  // The saved value differs from the one this session runs with (and could be applied)
  const needsRestart =
    status !== null && status.supported && value !== status.active && (value !== 'wsl' || wslAvailable);

  const notes: string[] = [];
  if (!availability && checking) {
    notes.push(t('theme.wslChecking'));
  } else if (availability && !availability.available) {
    notes.push(t(`theme.wslUnavailable.${availability.reason ?? 'error'}`));
  }
  if (status?.configured === 'wsl' && status.active !== 'wsl' && status.ready) {
    notes.push(t('theme.wslFallback'));
  }

  return (
    <SettingsRow
      label={t('theme.windowsShell')}
      description={
        <span className="flex flex-col gap-1">
          <span>{t('theme.windowsShellDescription')}</span>
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      }
    >
      {availability && !availability.available && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 px-0"
          onClick={() => void checkWsl()}
          disabled={checking}
          aria-label={t('theme.wslCheckAgain')}
          title={t('theme.wslCheckAgain')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        </Button>
      )}
      {needsRestart && (
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>
          {t('theme.restartToApply')}
        </Button>
      )}
      <SegmentedControl
        value={value}
        options={options}
        onValueChange={handleChange}
        ariaLabel={t('theme.windowsShell')}
      />
    </SettingsRow>
  );
}
