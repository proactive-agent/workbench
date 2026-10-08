import { useState, useEffect, useRef } from 'react';
import {
  updateProjectSettings,
  checkProjectVersion,
  initializeProject
} from '../../../stores/project-store';
import { setProjectEnvConfig } from '../../../stores/project-env-store';
import type {
  Project,
  ProjectSettings as ProjectSettingsType,
  AutoBuildVersionInfo,
  ProjectEnvConfig
} from '../../../../shared/types';

export interface UseProjectSettingsReturn {
  // Settings state
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  isSaving: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;

  // Version info
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;

  // Environment config
  envConfig: ProjectEnvConfig | null;
  setEnvConfig: React.Dispatch<React.SetStateAction<ProjectEnvConfig | null>>;
  isLoadingEnv: boolean;
  envError: string | null;
  setEnvError: React.Dispatch<React.SetStateAction<string | null>>;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => Promise<void>;

  // Password visibility toggles
  showClaudeToken: boolean;
  setShowClaudeToken: React.Dispatch<React.SetStateAction<boolean>>;
  showOpenAIKey: boolean;
  setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;

  // Collapsible sections
  expandedSections: Record<string, boolean>;
  toggleSection: (section: string) => void;

  // Actions
  handleInitialize: () => Promise<void>;
  handleSave: (onClose: () => void) => Promise<void>;
}

export function useProjectSettings(
  project: Project,
  open: boolean
): UseProjectSettingsReturn {
  const [settings, setSettings] = useState<ProjectSettingsType>(project.settings);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<AutoBuildVersionInfo | null>(null);
  const [isCheckingVersion, setIsCheckingVersion] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  // Environment configuration state
  // NOTE: We maintain local envConfig state AND update the global project-env-store.
  // This dual-state pattern is intentional:
  // - Local state: allows dialog-scoped edits, immediate UI feedback
  // - Global store: syncs to Sidebar and other components for real-time updates
  // The local state is the source of truth for this dialog's edits.
  const [envConfig, setEnvConfig] = useState<ProjectEnvConfig | null>(null);
  const [isLoadingEnv, setIsLoadingEnv] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  // Ref to track the latest committed config - used to handle concurrent updateEnvConfig calls
  // This ensures rapid updates don't lose changes due to stale state reads
  const committedEnvConfigRef = useRef<ProjectEnvConfig | null>(null);

  // Password visibility toggles
  const [showClaudeToken, setShowClaudeToken] = useState(false);
  const [showOpenAIKey, setShowOpenAIKey] = useState(false);

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    claude: true,
    memory: false
  });

  // Reset settings when project changes
  useEffect(() => {
    setSettings(project.settings);
  }, [project]);

  // Check version when dialog opens
  useEffect(() => {
    const checkVersion = async () => {
      if (open && project.autoBuildPath) {
        setIsCheckingVersion(true);
        const info = await checkProjectVersion(project.id);
        setVersionInfo(info);
        setIsCheckingVersion(false);
      }
    };
    checkVersion();
  }, [open, project.id, project.autoBuildPath]);

  // Load environment config when dialog opens
  useEffect(() => {
    const loadEnvConfig = async () => {
      if (open && project.autoBuildPath) {
        setIsLoadingEnv(true);
        setEnvError(null);
        try {
          const result = await window.electronAPI.getProjectEnv(project.id);
          if (result.success && result.data) {
            setEnvConfig(result.data);
            committedEnvConfigRef.current = result.data;
            // Update the shared store so other components (like Sidebar) can react
            setProjectEnvConfig(project.id, result.data);
          } else {
            setEnvError(result.error || 'Failed to load environment config');
          }
        } catch (err) {
          setEnvError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
          setIsLoadingEnv(false);
        }
      }
    };
    loadEnvConfig();
  }, [open, project.id, project.autoBuildPath]);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleInitialize = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      const result = await initializeProject(project.id);
      if (result?.success) {
        const info = await checkProjectVersion(project.id);
        setVersionInfo(info);
        const envResult = await window.electronAPI.getProjectEnv(project.id);
        if (envResult.success && envResult.data) {
          setEnvConfig(envResult.data);
          committedEnvConfigRef.current = envResult.data;
          // Update the shared env config store
          setProjectEnvConfig(project.id, envResult.data);
        }
      } else {
        setError(result?.error || 'Failed to initialize');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSave = async (onClose: () => void) => {
    setIsSaving(true);
    setError(null);

    try {
      const success = await updateProjectSettings(project.id, settings);
      if (!success) {
        setError('Failed to save settings');
        return;
      }

      if (envConfig) {
        const envResult = await window.electronAPI.updateProjectEnv(project.id, envConfig);
        if (!envResult.success) {
          setError(envResult.error || 'Failed to save environment config');
          return;
        }
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  };

  const updateEnvConfig = async (updates: Partial<ProjectEnvConfig>) => {
    // Use the committed ref as base to handle concurrent calls correctly
    // This ensures rapid updates don't lose changes due to stale state reads
    const baseConfig = committedEnvConfigRef.current || envConfig;
    if (!baseConfig) return;

    const newConfig = { ...baseConfig, ...updates };

    // Update the ref BEFORE the await (optimistically) to prevent race conditions
    // If two calls happen rapidly, the second will see the first's changes in the ref
    committedEnvConfigRef.current = newConfig;

    // Save to backend
    try {
      const result = await window.electronAPI.updateProjectEnv(project.id, newConfig);
      if (!result.success) {
        console.error('[useProjectSettings] Failed to auto-save env config:', result.error);
        setEnvError(result.error || 'Failed to save environment config');
        // Note: We don't rollback the ref here because another concurrent call may have
        // already updated it. The error is shown to the user who can retry.
        return;
      }
    } catch (err) {
      console.error('[useProjectSettings] Error auto-saving env config:', err);
      setEnvError(err instanceof Error ? err.message : 'Failed to save environment config');
      // Note: We don't rollback the ref here for the same reason as above.
      return;
    }

    // Clear any previous error on successful save
    setEnvError(null);

    // Update local state after successful backend save
    setEnvConfig(newConfig);

    // Update the shared store so other components (like Sidebar) can react immediately
    setProjectEnvConfig(project.id, newConfig);
  };

  return {
    settings,
    setSettings,
    isSaving,
    error,
    setError,
    versionInfo,
    isCheckingVersion,
    isUpdating,
    envConfig,
    setEnvConfig,
    isLoadingEnv,
    envError,
    setEnvError,
    updateEnvConfig,
    showClaudeToken,
    setShowClaudeToken,
    showOpenAIKey,
    setShowOpenAIKey,
    expandedSections,
    toggleSection,
    handleInitialize,
    handleSave
  };
}
