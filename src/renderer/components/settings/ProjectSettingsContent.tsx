import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { useProjectSettings, UseProjectSettingsReturn } from '../project-settings/hooks/useProjectSettings';
import { updateProjectSettings } from '../../stores/project-store';
import { EmptyProjectState } from './common/EmptyProjectState';
import { ErrorDisplay } from './common/ErrorDisplay';
import { SectionRouter } from './sections/SectionRouter';
import { createHookProxy } from './utils/hookProxyFactory';
import type { Project } from '../../../shared/types';

export type ProjectSettingsSection = 'general' | 'queue' | 'memory' | 'context';

/**
 * Project sections that are self-contained pages (they load and persist their own data) rather
 * than parts of the project settings form; the dialog renders them full-height
 */
export const STANDALONE_PROJECT_SECTIONS: ReadonlySet<ProjectSettingsSection> = new Set(['context']);

interface ProjectSettingsContentProps {
  project: Project | undefined;
  activeSection: ProjectSettingsSection;
  isOpen: boolean;
  onHookReady: (hook: UseProjectSettingsReturn | null) => void;
}

/**
 * Renders project settings content based on the active section.
 * Exposes hook state to parent for save coordination.
 */
export function ProjectSettingsContent({
  project,
  activeSection,
  isOpen,
  onHookReady
}: ProjectSettingsContentProps) {
  const { t } = useTranslation('settings');

  // Show empty state if no project selected
  if (!project) {
    return (
      <SettingsSection
        title={t('projectSettings.noProjectSelected.title')}
        description={t('projectSettings.noProjectSelected.description')}
      >
        <EmptyProjectState />
      </SettingsSection>
    );
  }

  return (
    <ProjectSettingsContentInner
      project={project}
      activeSection={activeSection}
      isOpen={isOpen}
      onHookReady={onHookReady}
    />
  );
}

/**
 * Inner component that uses the project settings hook.
 * Separated to ensure the hook is only called when a project is selected.
 */
function ProjectSettingsContentInner({
  project,
  activeSection,
  isOpen,
  onHookReady
}: {
  project: Project;
  activeSection: ProjectSettingsSection;
  isOpen: boolean;
  onHookReady: (hook: UseProjectSettingsReturn | null) => void;
}) {
  const hook = useProjectSettings(project, isOpen);

  // Keep a stable ref to the hook for the parent
  const hookRef = useRef(hook);
  hookRef.current = hook;

  const {
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
    expandedSections: _expandedSections,
    toggleSection: _toggleSection,
    handleInitialize,
    error
  } = hook;

  // Project settings save as they change (no Save button); quick edits are batched
  const savedSettingsRef = useRef(JSON.stringify(project.settings));
  useEffect(() => {
    const next = JSON.stringify(settings);
    if (next === savedSettingsRef.current) return;
    const timer = setTimeout(() => {
      savedSettingsRef.current = next;
      void updateProjectSettings(project.id, settings);
    }, 400);
    return () => clearTimeout(timer);
  }, [settings, project.id]);

  // Expose hook to parent for save coordination - only once when dialog opens
  // We use hookRef to avoid infinite loops (hook object is recreated each render)
  useEffect(() => {
    if (isOpen) {
      const hookProxy = createHookProxy(hookRef);
      onHookReady(hookProxy);
    }
    return () => {
      onHookReady(null);
    };
  }, [isOpen, onHookReady]);

  return (
    <>
      <SectionRouter
        activeSection={activeSection}
        project={project}
        settings={settings}
        setSettings={setSettings}
        versionInfo={versionInfo}
        isCheckingVersion={isCheckingVersion}
        isUpdating={isUpdating}
        envConfig={envConfig}
        isLoadingEnv={isLoadingEnv}
        envError={envError}
        updateEnvConfig={updateEnvConfig}
        showOpenAIKey={showOpenAIKey}
        setShowOpenAIKey={setShowOpenAIKey}
        handleInitialize={handleInitialize}
      />

      <ErrorDisplay error={error} envError={envError} />
    </>
  );
}
