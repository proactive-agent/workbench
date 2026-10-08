import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Copy, RefreshCw, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { useSettingsStore } from '../../stores/settings-store';
import { notifySentryStateChanged } from '../../lib/sentry';

interface DebugInfo {
  systemInfo: Record<string, string>;
  recentErrors: string[];
  logsPath: string;
  debugReport: string;
}

/**
 * Debug settings component for accessing logs and debug information
 */
export function DebugSettings() {
  const { t } = useTranslation('settings');
  const { settings, updateSettings } = useSettingsStore();
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle Sentry toggle
  const handleSentryToggle = async (checked: boolean) => {
    setError(null);
    try {
      const result = await window.electronAPI.saveSettings({ sentryEnabled: checked });
      if (result.success) {
        updateSettings({ sentryEnabled: checked });
        notifySentryStateChanged(checked);
      } else {
        setError(t('debug.errorReporting.saveFailed', 'Failed to save error reporting setting'));
      }
    } catch (_err) {
      setError(t('debug.errorReporting.saveFailed', 'Failed to save error reporting setting'));
    }
  };

  const loadDebugInfo = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const info = await window.electronAPI.getDebugInfo();
      setDebugInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load debug info');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenLogsFolder = async () => {
    try {
      const result = await window.electronAPI.openLogsFolder();
      if (!result.success) {
        setError(result.error || 'Failed to open logs folder');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open logs folder');
    }
  };

  const handleCopyDebugInfo = async () => {
    try {
      const result = await window.electronAPI.copyDebugInfo();
      if (result.success) {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        setError(result.error || 'Failed to copy debug info');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy debug info');
    }
  };

  return (
    <SettingsSection
      title={t('debug.title', 'Debug & logs')}
      description={t('debug.description', 'Access logs and debug information for troubleshooting')}
    >
        <SettingsRows>
          {/* Error Reporting Toggle */}
          <SettingsRow
            label={t('debug.errorReporting.label', 'Anonymous error reporting')}
            description={t('debug.errorReporting.description', 'Send crash reports to help improve Auto Claude. No personal data or code is collected.')}
            htmlFor="sentry-toggle"
          >
            <Switch
              id="sentry-toggle"
              checked={settings.sentryEnabled ?? true}
              onCheckedChange={handleSentryToggle}
            />
          </SettingsRow>

          {/* Copy debug info (for bug reports) */}
          <SettingsRow
            label={t('debug.helpTitle', 'Reporting issues')}
            description={t('debug.helpText', 'When reporting bugs, click "Copy Debug Info" to get system information and recent errors that help us diagnose the issue.')}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyDebugInfo}
              disabled={copySuccess}
            >
              {copySuccess ? (
                <>
                  {t('debug.copied', 'Copied!')}
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                  {t('debug.copyDebugInfo', 'Copy debug info')}
                </>
              )}
            </Button>
          </SettingsRow>

          {/* Logs folder */}
          <SettingsRow
            label={t('debug.logsLocation', 'Logs location')}
            description={debugInfo ? <span className="break-all font-mono text-xs">{debugInfo.logsPath}</span> : undefined}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenLogsFolder}
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
              {t('debug.openLogsFolder', 'Open logs folder')}
            </Button>
          </SettingsRow>

          {/* System information + recent errors */}
          <SettingsRow
            label={t('debug.systemInfo', 'System information')}
            footer={debugInfo ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border px-4 py-3 text-xs">
                  {Object.entries(debugInfo.systemInfo).map(([key, value]) => (
                    <div key={key} className="flex min-w-0 justify-between gap-2">
                      <span className="shrink-0 text-muted-foreground">{key}</span>
                      <span className="truncate text-right font-mono text-foreground" title={value}>{value}</span>
                    </div>
                  ))}
                </div>

                {debugInfo.recentErrors.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-sm text-foreground">
                      {t('debug.recentErrors', 'Recent errors')} ({debugInfo.recentErrors.length})
                    </p>
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl bg-segment-track px-4 py-3">
                      {debugInfo.recentErrors.map((recentError, index) => (
                        <div key={index} className="break-all font-mono text-xs text-muted-foreground">
                          {recentError}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    {t('debug.noRecentErrors', 'No recent errors')}
                  </p>
                )}
              </div>
            ) : undefined}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={loadDebugInfo}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              {t('debug.loadInfo', 'Load debug info')}
            </Button>
          </SettingsRow>
        </SettingsRows>

        {/* Error Display */}
        {error && (
          <p className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            {error}
          </p>
        )}
    </SettingsSection>
  );
}
