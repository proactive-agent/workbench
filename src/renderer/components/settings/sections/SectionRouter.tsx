import { useTranslation } from 'react-i18next';
import type { Project, ProjectSettings as ProjectSettingsType, AutoBuildVersionInfo, ProjectEnvConfig } from '../../../../shared/types';
import { GeneralSettings } from '../../project-settings/GeneralSettings';
import { SecuritySettings } from '../../project-settings/SecuritySettings';
import { ProjectMemorySections } from '../../context/ProjectMemorySections';
import { BranchSettings } from '../../project-settings/BranchSettings';
import { InitializationGuard } from '../common/InitializationGuard';
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
  showOpenAIKey: boolean;
  setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;
  handleInitialize: () => Promise<void>;
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
  showOpenAIKey,
  setShowOpenAIKey,
  handleInitialize
}: SectionRouterProps) {
  const { t } = useTranslation('settings');

  switch (activeSection) {
    case 'general':
      return (
        <>
          <GeneralSettings
            project={project}
            settings={settings}
            setSettings={setSettings}
            versionInfo={versionInfo}
            isCheckingVersion={isCheckingVersion}
            isUpdating={isUpdating}
            handleInitialize={handleInitialize}
          />
          {project.autoBuildPath && (
            <BranchSettings
              projectPath={project.path}
              settings={settings}
              setSettings={setSettings}
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
            />
          )}
        </>
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
          <ProjectMemorySections projectId={project.id} />
        </InitializationGuard>
      );

    default:
      return null;
  }
}
