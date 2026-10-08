import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  CheckCircle2,
  Download,
  ArrowDownToLine,
  X,
  AlertCircle
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Progress } from '../ui/progress';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import type {
  AppSettings,
  AppUpdateAvailableEvent,
  AppUpdateCheckStatus,
  AppUpdateProgress,
  AppUpdateInfo,
  NotificationSettings
} from '../../../shared/types';

/**
 * Release notes renderer that handles both HTML and markdown input.
 * GitHub release notes come as HTML, so we detect and handle both formats.
 * Uses ReactMarkdown with rehype-sanitize to prevent XSS attacks.
 */
/** Safe link component that opens external URLs in the default browser */
const safeMarkdownComponents: Components = {
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
    return (
      <a
        href={href}
        {...props}
        {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
        className="text-primary hover:underline"
      >
        {children}
      </a>
    );
  }
};

function ReleaseNotesRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_ul]:ml-4 [&_ol]:ml-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={safeMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface AdvancedSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'updates' | 'notifications';
  version: string;
}

/**
 * Advanced settings for updates and notifications
 */
export function AdvancedSettings({ settings, onSettingsChange, section, version }: AdvancedSettingsProps) {
  const { t } = useTranslation('settings');

  // Electron app update state
  const [appUpdateInfo, setAppUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);
  const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);
  // Outcome of the last check; "latest" is only claimed when the check confirmed it
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateCheckStatus | null>(null);
  const [isDownloadingAppUpdate, setIsDownloadingAppUpdate] = useState(false);
  const [appDownloadProgress, setAppDownloadProgress] = useState<AppUpdateProgress | null>(null);
  const [isAppUpdateDownloaded, setIsAppUpdateDownloaded] = useState(false);
  // Stable downgrade state (shown when user turns off beta while on prerelease)
  const [stableDowngradeInfo, setStableDowngradeInfo] = useState<AppUpdateInfo | null>(null);
  // Read-only volume warning (shown when trying to install from DMG)
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);
  // General update error state
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);

  // Check for updates on mount, including any already-downloaded updates
  useEffect(() => {
    if (section !== 'updates') {
      return;
    }

    let isCancelled = false;

    // First check if an update was already downloaded, then check for new updates
    (async () => {
      // Check if an update was already downloaded (e.g., auto-downloaded in background)
      try {
        const result = await window.electronAPI.getDownloadedAppUpdate();

        // Skip state updates if component unmounted or section changed
        if (isCancelled) return;

        if (result.success && result.data) {
          // An update was already downloaded - show "Install and Restart" button
          setAppUpdateInfo(result.data);
          setIsAppUpdateDownloaded(true);
          console.log('[AdvancedSettings] Found already-downloaded update:', result.data.version);
          return; // Don't check for new updates if we already have one downloaded
        }
      } catch (err) {
        console.error('Failed to check for downloaded update:', err);
        if (isCancelled) return;
      }

      // Only check for available updates if no update is already downloaded
      // (electron-updater reports no available update when one is already downloaded,
      // which would clear our appUpdateInfo and lose the version metadata)
      // Inline the update check with cancellation support
      setIsCheckingAppUpdate(true);
      try {
        const result = await window.electronAPI.checkAppUpdate();
        if (isCancelled) return;
        setAppUpdateInfo(result.success ? result.data?.update ?? null : null);
        setAppUpdateStatus(result.success && result.data ? result.data.status : 'error');
      } catch (err) {
        console.error('Failed to check for app updates:', err);
        if (!isCancelled) setAppUpdateStatus('error');
      } finally {
        if (!isCancelled) {
          setIsCheckingAppUpdate(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [section]);

  // Listen for app update events
  useEffect(() => {
    const cleanupAvailable = window.electronAPI.onAppUpdateAvailable((info) => {
      setAppUpdateInfo(info);
      setIsCheckingAppUpdate(false);
      setShowReadOnlyWarning(false);
      setAppUpdateError(null);
    });

    const cleanupDownloaded = window.electronAPI.onAppUpdateDownloaded((info) => {
      setAppUpdateInfo(info);
      setIsDownloadingAppUpdate(false);
      setIsAppUpdateDownloaded(true);
      setAppDownloadProgress(null);
      // Clear downgrade info if any update downloaded
      setStableDowngradeInfo(null);
      // Reset read-only warning when a new update is downloaded
      setShowReadOnlyWarning(false);
      setAppUpdateError(null);
    });

    const cleanupProgress = window.electronAPI.onAppUpdateProgress((progress) => {
      setAppDownloadProgress(progress);
    });

    // Listen for stable downgrade available (when user turns off beta while on prerelease)
    const cleanupStableDowngrade = window.electronAPI.onAppUpdateStableDowngrade((info) => {
      setStableDowngradeInfo(info);
    });

    // Listen for read-only volume warning (when trying to install from DMG)
    const cleanupReadOnlyVolume = window.electronAPI.onAppUpdateReadOnlyVolume(() => {
      setShowReadOnlyWarning(true);
    });

    // Listen for update errors (e.g., install failures)
    const cleanupError = window.electronAPI.onAppUpdateError((error) => {
      setAppUpdateError(error.message);
      setIsDownloadingAppUpdate(false);
      setAppDownloadProgress(null);
    });

    return () => {
      cleanupAvailable();
      cleanupDownloaded();
      cleanupProgress();
      cleanupStableDowngrade();
      cleanupReadOnlyVolume();
      cleanupError();
    };
  }, []);

  const checkForAppUpdates = async () => {
    setIsCheckingAppUpdate(true);
    try {
      const result = await window.electronAPI.checkAppUpdate();
      setAppUpdateInfo(result.success ? result.data?.update ?? null : null);
      setAppUpdateStatus(result.success && result.data ? result.data.status : 'error');
    } catch (err) {
      console.error('Failed to check for app updates:', err);
      setAppUpdateStatus('error');
    } finally {
      setIsCheckingAppUpdate(false);
    }
  };

  const handleDownloadAppUpdate = async () => {
    setIsDownloadingAppUpdate(true);
    setAppUpdateError(null);
    try {
      const result = await window.electronAPI.downloadAppUpdate();
      if (!result.success) {
        setAppUpdateError(result.error || t('updates.downloadError'));
        setIsDownloadingAppUpdate(false);
      }
      // Note: Success case is handled by the onAppUpdateDownloaded event listener
    } catch (err) {
      console.error('Failed to download app update:', err);
      setAppUpdateError(t('updates.downloadError'));
      setIsDownloadingAppUpdate(false);
    }
  };

  const handleInstallAppUpdate = () => {
    window.electronAPI.installAppUpdate();
  };

  const handleDownloadStableVersion = async () => {
    setIsDownloadingAppUpdate(true);
    setAppUpdateError(null);
    try {
      // Use dedicated stable download API with allowDowngrade enabled
      const result = await window.electronAPI.downloadStableUpdate();
      if (!result.success) {
        setAppUpdateError(result.error || t('updates.downloadError'));
        setIsDownloadingAppUpdate(false);
      }
      // Note: Success case is handled by the onAppUpdateDownloaded event listener
    } catch (err) {
      console.error('Failed to download stable version:', err);
      setAppUpdateError(t('updates.downloadError'));
      setIsDownloadingAppUpdate(false);
    }
  };

  const dismissStableDowngrade = () => {
    setStableDowngradeInfo(null);
  };

  if (section === 'updates') {
    const renderDownloadProgress = () =>
      isDownloadingAppUpdate && appDownloadProgress ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('updates.downloading')}</span>
            <span className="text-foreground">{Math.round(appDownloadProgress.percent)}%</span>
          </div>
          <Progress value={appDownloadProgress.percent} className="h-1.5" />
          <p className="text-right text-xs text-muted-foreground">
            {(appDownloadProgress.transferred / 1024 / 1024).toFixed(2)} MB / {(appDownloadProgress.total / 1024 / 1024).toFixed(2)} MB
          </p>
        </div>
      ) : null;

    return (
      <SettingsSection
        title={t('updates.title')}
        description={t('updates.description')}
      >
        <SettingsRows>
          {/* Current Version Display */}
          <SettingsRow
            label={t('updates.version')}
            description={
              <span className="flex items-center gap-1.5">
                <span className="font-mono">{version || t('updates.loading')}</span>
                {appUpdateInfo ? (
                  <span>· {t('updates.newVersionAvailable')} {appUpdateInfo.version}</span>
                ) : (
                  !isCheckingAppUpdate &&
                  appUpdateStatus && (
                    <span>
                      ·{' '}
                      {appUpdateStatus === 'up-to-date'
                        ? t('updates.latestVersion')
                        : appUpdateStatus === 'unpublished'
                          ? t('updates.unpublishedVersion')
                          : t('updates.checkFailed')}
                    </span>
                  )
                )}
              </span>
            }
            footer={
              (appUpdateInfo || isAppUpdateDownloaded) ? (
                /* Electron App Update - shows when an update is available */
                <div className="space-y-4 rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">
                        {t('updates.appUpdateReady')}: <span className="font-mono">{appUpdateInfo?.version || 'Unknown'}</span>
                      </p>
                      {appUpdateInfo?.releaseDate && (
                        <p className="mt-0.5 text-sm text-(--nav-label-color)">
                          {t('updates.released')} {new Date(appUpdateInfo.releaseDate).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    {isAppUpdateDownloaded ? (
                      <Button size="sm" onClick={handleInstallAppUpdate} disabled={showReadOnlyWarning}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                        {t('updates.installAndRestart')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={handleDownloadAppUpdate} disabled={isDownloadingAppUpdate}>
                        {isDownloadingAppUpdate ? (
                          <>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                            {t('updates.downloading')}
                          </>
                        ) : (
                          <>
                            <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                            {t('updates.downloadUpdate')}
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  {/* Release Notes */}
                  {appUpdateInfo?.releaseNotes && (
                    <div className="max-h-48 overflow-y-auto rounded-lg bg-segment-track px-4 py-3">
                      <ReleaseNotesRenderer content={appUpdateInfo.releaseNotes} />
                    </div>
                  )}

                  {renderDownloadProgress()}

                  {/* Update Error */}
                  {appUpdateError && (
                    <p className="flex items-center gap-1.5 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      {appUpdateError}
                    </p>
                  )}

                  {/* Downloaded Success */}
                  {isAppUpdateDownloaded && !showReadOnlyWarning && (
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-success" strokeWidth={1.75} />
                      {t('updates.updateDownloaded')}
                    </p>
                  )}

                  {/* Read-Only Volume Warning */}
                  {showReadOnlyWarning && (
                    <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
                      <p className="text-foreground">{t('updates.readOnlyVolumeTitle')}</p>
                      <p className="mt-0.5 text-muted-foreground">{t('updates.readOnlyVolumeDescription')}</p>
                    </div>
                  )}
                </div>
              ) : undefined
            }
          >
            <Button
              size="sm"
              variant="outline"
              onClick={checkForAppUpdates}
              disabled={isCheckingAppUpdate}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isCheckingAppUpdate ? 'animate-spin' : ''}`} strokeWidth={1.75} />
              {t('updates.checkForUpdates')}
            </Button>
          </SettingsRow>

          <SettingsRow
            label={t('updates.autoUpdateProjects')}
            description={t('updates.autoUpdateProjectsDescription')}
            htmlFor="autoUpdateAutoBuild"
          >
            <Switch
              id="autoUpdateAutoBuild"
              checked={settings.autoUpdateAutoBuild}
              onCheckedChange={(checked) =>
                onSettingsChange({ ...settings, autoUpdateAutoBuild: checked })
              }
            />
          </SettingsRow>

          <SettingsRow
            label={t('updates.betaUpdates')}
            description={t('updates.betaUpdatesDescription')}
            htmlFor="betaUpdates"
            footer={
              /* Stable Downgrade - shown when user turns off beta while on prerelease */
              stableDowngradeInfo && !appUpdateInfo ? (
                <div className="space-y-4 rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">{t('updates.stableDowngradeAvailable')}</p>
                      <p className="mt-0.5 text-sm text-(--nav-label-color)">
                        {t('updates.stableDowngradeDescription')}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground"
                      onClick={dismissStableDowngrade}
                      aria-label={t('common:accessibility.dismissAriaLabel')}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </div>

                  <div className="text-sm">
                    <span className="text-(--nav-label-color)">{t('updates.stableVersion')}: </span>
                    <span className="font-mono text-foreground">{stableDowngradeInfo.version}</span>
                    {stableDowngradeInfo.releaseDate && (
                      <span className="text-(--nav-label-color)">
                        {' · '}{t('updates.released')} {new Date(stableDowngradeInfo.releaseDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* Release Notes */}
                  {stableDowngradeInfo.releaseNotes && (
                    <div className="max-h-48 overflow-y-auto rounded-lg bg-segment-track px-4 py-3">
                      <ReleaseNotesRenderer content={stableDowngradeInfo.releaseNotes} />
                    </div>
                  )}

                  {renderDownloadProgress()}

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleDownloadStableVersion}
                      disabled={isDownloadingAppUpdate}
                    >
                      {isDownloadingAppUpdate ? (
                        <>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                          {t('updates.downloading')}
                        </>
                      ) : (
                        <>
                          <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                          {t('updates.downloadStableVersion')}
                        </>
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={dismissStableDowngrade}>
                      {t('common:actions.dismiss')}
                    </Button>
                  </div>
                </div>
              ) : undefined
            }
          >
            <Switch
              id="betaUpdates"
              checked={settings.betaUpdates ?? false}
              onCheckedChange={(checked) => {
                onSettingsChange({ ...settings, betaUpdates: checked });
                if (checked) {
                  // Clear downgrade info when enabling beta again
                  setStableDowngradeInfo(null);
                } else {
                  // Clear beta update info when disabling beta, so stable downgrade UI can show
                  setAppUpdateInfo(null);
                }
              }}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
    );
  }

  // notifications section
  const notificationItems: Array<{
    key: keyof NotificationSettings;
    labelKey: string;
    descriptionKey: string;
  }> = [
    { key: 'onTaskComplete', labelKey: 'notifications.onTaskComplete', descriptionKey: 'notifications.onTaskCompleteDescription' },
    { key: 'onTaskFailed', labelKey: 'notifications.onTaskFailed', descriptionKey: 'notifications.onTaskFailedDescription' },
    { key: 'onReviewNeeded', labelKey: 'notifications.onReviewNeeded', descriptionKey: 'notifications.onReviewNeededDescription' },
    { key: 'sound', labelKey: 'notifications.sound', descriptionKey: 'notifications.soundDescription' }
  ];

  return (
    <SettingsSection
      title={t('notifications.title')}
      description={t('notifications.description')}
    >
      <SettingsRows>
        {notificationItems.map((item) => (
          <SettingsRow
            key={item.key}
            label={t(item.labelKey)}
            description={t(item.descriptionKey)}
            htmlFor={`notification-${item.key}`}
          >
            <Switch
              id={`notification-${item.key}`}
              checked={settings.notifications[item.key]}
              onCheckedChange={(checked) =>
                onSettingsChange({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    [item.key]: checked
                  }
                })
              }
            />
          </SettingsRow>
        ))}
      </SettingsRows>
    </SettingsSection>
  );
}
