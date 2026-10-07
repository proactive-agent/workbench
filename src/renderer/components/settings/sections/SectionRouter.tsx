import { useTranslation } from 'react-i18next';
import type { Project, ProjectSettings as ProjectSettingsType, AutoBuildVersionInfo, ProjectEnvConfig, LinearSyncStatus, GitHubSyncStatus, GitLabSyncStatus } from '../../../../shared/types';
import { SettingsSection } from '../SettingsSection';
import { GeneralSettings } from '../../project-settings/GeneralSettings';
import { SecuritySettings } from '../../project-settings/SecuritySettings';
import { LinearIntegration } from '../integrations/LinearIntegration';
import { GitHubIntegration } from '../integrations/GitHubIntegration';
import { GitLabIntegration } from '../integrations/GitLabIntegration';
import { InitializationGuard } from '../common/InitializationGuard';
import { SettingsRow, SettingsRows } from '../SettingsRow';
import { Input } from '../../ui/input';
import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT, MIN_PARALLEL_TASKS } from '../../../../shared/constants/task';
import type { ProjectSettingsSection } from '../ProjectSettingsContent';

interface SectionRouterProps {
  activeSection: ProjectSettingsSection;
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  envConfig: ProjectEnvConfig | null;
  isLoadingEnv: boolean;
  envError: string | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showLinearKey: boolean;
  setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
  showOpenAIKey: boolean;
  setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;
  showGitHubToken: boolean;
  setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitHubConnectionStatus: GitHubSyncStatus | null;
  isCheckingGitHub: boolean;
  showGitLabToken: boolean;
  setShowGitLabToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitLabConnectionStatus: GitLabSyncStatus | null;
  isCheckingGitLab: boolean;
  linearConnectionStatus: LinearSyncStatus | null;
  isCheckingLinear: boolean;
  handleInitialize: () => Promise<void>;
  onOpenLinearImport: () => void;
}

/**
 * Routes to the appropriate settings section based on activeSection.
 * Handles initialization guards and section-specific configurations.
 */
export function SectionRouter({
  activeSection,
  project,
  settings,
  setSettings,
  versionInfo,
  isCheckingVersion,
  isUpdating,
  envConfig,
  isLoadingEnv,
  envError,
  updateEnvConfig,
  showLinearKey,
  setShowLinearKey,
  showOpenAIKey,
  setShowOpenAIKey,
  showGitHubToken,
  setShowGitHubToken,
  gitHubConnectionStatus,
  isCheckingGitHub,
  showGitLabToken,
  setShowGitLabToken,
  gitLabConnectionStatus,
  isCheckingGitLab,
  linearConnectionStatus,
  isCheckingLinear,
  handleInitialize,
  onOpenLinearImport
}: SectionRouterProps) {
  const { t } = useTranslation('settings');

  switch (activeSection) {
    case 'general':
      return (
        <GeneralSettings
          project={project}
          settings={settings}
          setSettings={setSettings}
          versionInfo={versionInfo}
          isCheckingVersion={isCheckingVersion}
          isUpdating={isUpdating}
          handleInitialize={handleInitialize}
        />
      );

    case 'queue':
      return (
        <SettingsSection title={t('projectSections.queue.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('projectSections.queue.maxParallelTasks')}
              description={t('projectSections.queue.maxParallelTasksDescription', {
                min: MIN_PARALLEL_TASKS,
                max: MAX_PARALLEL_TASKS_LIMIT
              })}
              htmlFor="maxParallelTasks"
            >
              <Input
                id="maxParallelTasks"
                type="number"
                min={MIN_PARALLEL_TASKS}
                max={MAX_PARALLEL_TASKS_LIMIT}
                className="w-20"
                value={settings.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (e.target.value === '' || !Number.isFinite(value)) return;
                  const clamped = Math.min(MAX_PARALLEL_TASKS_LIMIT, Math.max(MIN_PARALLEL_TASKS, Math.round(value)));
                  setSettings((prev) => ({ ...prev, maxParallelTasks: clamped }));
                }}
              />
            </SettingsRow>
          </SettingsRows>
        </SettingsSection>
      );

    case 'linear':
      return (
        <SettingsSection
          title={t('projectSections.linear.integrationTitle')}
          description={t('projectSections.linear.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.linear.integrationTitle')}
            description={t('projectSections.linear.syncDescription')}
          >
            <LinearIntegration
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showLinearKey={showLinearKey}
              setShowLinearKey={setShowLinearKey}
              linearConnectionStatus={linearConnectionStatus}
              isCheckingLinear={isCheckingLinear}
              onOpenLinearImport={onOpenLinearImport}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'github':
      return (
        <InitializationGuard
          initialized={!!project.autoBuildPath}
          title={t('projectSections.github.title')}
          description={t('projectSections.github.syncDescription')}
        >
          <GitHubIntegration
            envConfig={envConfig}
            updateEnvConfig={updateEnvConfig}
            showGitHubToken={showGitHubToken}
            setShowGitHubToken={setShowGitHubToken}
            gitHubConnectionStatus={gitHubConnectionStatus}
            isCheckingGitHub={isCheckingGitHub}
            projectPath={project.path}
            settings={settings}
            setSettings={setSettings}
          />
        </InitializationGuard>
      );

    case 'gitlab':
      return (
        <InitializationGuard
          initialized={!!project.autoBuildPath}
          title={t('projectSections.gitlab.title')}
          description={t('projectSections.gitlab.syncDescription')}
        >
          <GitLabIntegration
            envConfig={envConfig}
            updateEnvConfig={updateEnvConfig}
            showGitLabToken={showGitLabToken}
            setShowGitLabToken={setShowGitLabToken}
            gitLabConnectionStatus={gitLabConnectionStatus}
            isCheckingGitLab={isCheckingGitLab}
            projectPath={project.path}
            settings={settings}
            setSettings={setSettings}
          />
        </InitializationGuard>
      );

    case 'memory':
      return (
        <InitializationGuard
          initialized={!!project.autoBuildPath}
          title={t('projectSections.memory.title')}
          description={t('projectSections.memory.syncDescription')}
        >
          <SecuritySettings
            envConfig={envConfig}
            settings={settings}
            setSettings={setSettings}
            updateEnvConfig={updateEnvConfig}
            showOpenAIKey={showOpenAIKey}
            setShowOpenAIKey={setShowOpenAIKey}
            expanded={true}
            onToggle={() => {}}
          />
        </InitializationGuard>
      );

    default:
      return null;
  }
}
