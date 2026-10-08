import { RefreshCw, Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { AVAILABLE_MODELS } from '../../../shared/constants';
import type {
  Project,
  ProjectSettings as ProjectSettingsType,
  AutoBuildVersionInfo
} from '../../../shared/types';

interface GeneralSettingsProps {
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  handleInitialize: () => Promise<void>;
}

type NotificationKey = keyof ProjectSettingsType['notifications'];

const NOTIFICATION_KEYS: NotificationKey[] = ['onTaskComplete', 'onTaskFailed', 'onReviewNeeded', 'sound'];

/**
 * Project "General" page: Auto-Build status, agent defaults and notifications,
 * laid out as claude.ai settings sections.
 */
export function GeneralSettings({
  project,
  settings,
  setSettings,
  versionInfo,
  isCheckingVersion,
  isUpdating,
  handleInitialize
}: GeneralSettingsProps) {
  const { t } = useTranslation(['settings']);

  const renderAutoBuildStatus = () => {
    if (isCheckingVersion) {
      return (
        <span className="flex items-center gap-2 text-sm text-(--nav-label-color)">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          {t('projectPages.general.checkingStatus')}
        </span>
      );
    }
    const initialized = versionInfo ? versionInfo.isInitialized : true;
    return (
      <span className="flex items-center gap-1.5 text-sm text-(--nav-label-color)">
        {initialized ? t('projectPages.general.initialized') : t('projectPages.general.notInitialized')}
      </span>
    );
  };

  return (
    <>
      <SettingsSection title={t('projectPages.general.autoBuildTitle')}>
        <SettingsRows>
          {!project.autoBuildPath ? (
            <SettingsRow
              label={t('projectPages.general.notInitialized')}
              description={t('projectPages.general.notInitializedDescription')}
            >
              <Button variant="outline" size="sm" onClick={handleInitialize} disabled={isUpdating} className="gap-2">
                {isUpdating ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                    {t('projectPages.general.initializing')}
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" strokeWidth={1.75} />
                    {t('projectPages.general.initialize')}
                  </>
                )}
              </Button>
            </SettingsRow>
          ) : (
            <SettingsRow
              label={t('projectPages.general.dataFolder')}
              description={<code className="font-mono text-[0.8125rem]">{project.autoBuildPath}</code>}
            >
              {renderAutoBuildStatus()}
            </SettingsRow>
          )}
        </SettingsRows>
      </SettingsSection>

      {project.autoBuildPath && (
        <>
          <SettingsSection title={t('projectPages.general.agentTitle')}>
            <SettingsRows>
              <SettingsRow
                label={t('projectPages.general.model')}
                description={t('projectPages.general.modelDescription')}
                htmlFor="project-model"
              >
                <Select
                  value={settings.model}
                  onValueChange={(value) => setSettings({ ...settings, model: value })}
                >
                  <SelectTrigger id="project-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {AVAILABLE_MODELS.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow
                label={t('projectSections.general.useClaudeMd')}
                description={t('projectSections.general.useClaudeMdDescription')}
              >
                <Switch
                  checked={settings.useClaudeMd ?? true}
                  onCheckedChange={(checked) => setSettings({ ...settings, useClaudeMd: checked })}
                  aria-label={t('projectSections.general.useClaudeMd')}
                />
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('projectPages.general.notificationsTitle')}>
            <SettingsRows>
              {NOTIFICATION_KEYS.map((key) => (
                <SettingsRow
                  key={key}
                  label={t(`projectPages.general.notifications.${key}`)}
                  description={t(`projectPages.general.notifications.${key}Description`)}
                >
                  <Switch
                    checked={settings.notifications[key]}
                    onCheckedChange={(checked) =>
                      setSettings({
                        ...settings,
                        notifications: { ...settings.notifications, [key]: checked }
                      })
                    }
                    aria-label={t(`projectPages.general.notifications.${key}`)}
                  />
                </SettingsRow>
              ))}
            </SettingsRows>
          </SettingsSection>
        </>
      )}
    </>
  );
}
