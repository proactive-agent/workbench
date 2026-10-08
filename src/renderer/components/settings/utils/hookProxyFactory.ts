import type { UseProjectSettingsReturn } from '../../project-settings/hooks/useProjectSettings';
import type { MutableRefObject } from 'react';

/**
 * Creates a proxy that always accesses the latest hook values via ref.
 * This prevents infinite loops caused by hook object recreation on each render.
 *
 * @param hookRef - Stable reference to the hook return value
 * @returns Proxy that provides access to the latest hook state
 */
export function createHookProxy(
  hookRef: MutableRefObject<UseProjectSettingsReturn>
): UseProjectSettingsReturn {
  return {
    get settings() { return hookRef.current.settings; },
    get setSettings() { return hookRef.current.setSettings; },
    get isSaving() { return hookRef.current.isSaving; },
    get error() { return hookRef.current.error; },
    get setError() { return hookRef.current.setError; },
    get versionInfo() { return hookRef.current.versionInfo; },
    get isCheckingVersion() { return hookRef.current.isCheckingVersion; },
    get isUpdating() { return hookRef.current.isUpdating; },
    get envConfig() { return hookRef.current.envConfig; },
    get setEnvConfig() { return hookRef.current.setEnvConfig; },
    get isLoadingEnv() { return hookRef.current.isLoadingEnv; },
    get envError() { return hookRef.current.envError; },
    get setEnvError() { return hookRef.current.setEnvError; },
    get updateEnvConfig() { return hookRef.current.updateEnvConfig; },
    get showClaudeToken() { return hookRef.current.showClaudeToken; },
    get setShowClaudeToken() { return hookRef.current.setShowClaudeToken; },
    get showOpenAIKey() { return hookRef.current.showOpenAIKey; },
    get setShowOpenAIKey() { return hookRef.current.setShowOpenAIKey; },
    get expandedSections() { return hookRef.current.expandedSections; },
    get toggleSection() { return hookRef.current.toggleSection; },
    get handleInitialize() { return hookRef.current.handleInitialize; },
    get handleSave() { return hookRef.current.handleSave; },
  };
}
