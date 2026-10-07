import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveProvider } from '../../hooks/useActiveProvider';
import { getProviderModelLabel } from '../../../shared/utils/model-display';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_AGENT_PROFILES,
  AVAILABLE_MODELS,
  THINKING_LEVELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  PHASE_KEYS,
  getProviderPreset
} from '../../../shared/constants';
import { useSettingsStore, saveSettings, saveProviderAgentConfig } from '../../stores/settings-store';
import { MultiProviderModelSelect } from './MultiProviderModelSelect';
import { ReasoningTypeHint, ThinkingLevelSelect } from './ThinkingLevelSelect';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows, SegmentedControl } from './SettingsRow';
import { Button } from '../ui/button';
import type { PhaseModelConfig, PhaseThinkingConfig, ThinkingLevel } from '../../../shared/types/settings';
import type { BuiltinProvider } from '../../../shared/types/provider-account';

/**
 * Agent Profile Settings component
 * Displays preset agent profiles for quick model/thinking level configuration
 * All presets show phase configuration for full customization
 */
interface AgentProfileSettingsProps {
  provider?: BuiltinProvider;
  /** Rows rendered above the profile row in the "Agent profile" section (e.g. the provider switch) */
  leadingRows?: React.ReactNode;
}

export function AgentProfileSettings({ provider, leadingRows }: AgentProfileSettingsProps) {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((state) => state.settings);
  const { provider: activeProvider } = useActiveProvider();
  // Read per-provider config with fallback to global
  const providerConfig = provider ? settings.providerAgentConfig?.[provider] : undefined;
  const selectedProfileId = providerConfig?.selectedAgentProfile ?? settings.selectedAgentProfile ?? 'auto';

  // Find the selected profile
  const selectedProfile = useMemo(() =>
    DEFAULT_AGENT_PROFILES.find(p => p.id === selectedProfileId) || DEFAULT_AGENT_PROFILES[0],
    [selectedProfileId]
  );

  // Get profile's default phase config - provider-aware
  const providerPreset = provider
    ? getProviderPreset(provider, selectedProfileId)
    : null;
  const profilePhaseModels = providerPreset?.phaseModels ?? selectedProfile.phaseModels ?? DEFAULT_PHASE_MODELS;
  const profilePhaseThinking = providerPreset?.phaseThinking ?? selectedProfile.phaseThinking ?? DEFAULT_PHASE_THINKING;

  // Get current phase config from settings (custom) or fall back to profile defaults
  // When viewing a provider tab, skip global fallback — use provider-specific config or preset defaults
  const currentPhaseModels: PhaseModelConfig = provider
    ? (providerConfig?.customPhaseModels ?? profilePhaseModels)
    : (settings.customPhaseModels ?? profilePhaseModels);
  const currentPhaseThinking: PhaseThinkingConfig = provider
    ? (providerConfig?.customPhaseThinking ?? profilePhaseThinking)
    : (settings.customPhaseThinking ?? profilePhaseThinking);

  /**
   * Check if current config differs from the selected profile's defaults
   */
  const hasCustomConfig = useMemo((): boolean => {
    const customModels = provider ? providerConfig?.customPhaseModels : settings.customPhaseModels;
    const customThinking = provider ? providerConfig?.customPhaseThinking : settings.customPhaseThinking;
    if (!customModels && !customThinking) {
      return false; // No custom settings, using profile defaults
    }
    return PHASE_KEYS.some(
      phase =>
        currentPhaseModels[phase] !== profilePhaseModels[phase] ||
        currentPhaseThinking[phase] !== profilePhaseThinking[phase]
    );
  }, [provider, providerConfig, settings.customPhaseModels, settings.customPhaseThinking, currentPhaseModels, currentPhaseThinking, profilePhaseModels, profilePhaseThinking]);

  const handleSelectProfile = async (profileId: string) => {
    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === profileId);
    if (!profile) return;

    if (provider) {
      // When selecting on a provider tab, deactivate cross-provider mode
      await saveProviderAgentConfig(provider, {
        selectedAgentProfile: profileId,
        customPhaseModels: undefined,
        customPhaseThinking: undefined,
      });
      // Deactivate cross-provider mode when a provider profile is selected
      if (settings.customMixedProfileActive) {
        await saveSettings({ customMixedProfileActive: false });
      }
    } else {
      await saveSettings({
        selectedAgentProfile: profileId,
        customMixedProfileActive: false,
        customPhaseModels: undefined,
        customPhaseThinking: undefined,
      });
    }
  };

  const handlePhaseModelChange = async (phase: keyof PhaseModelConfig, value: string) => {
    // Save as custom config (deviating from preset)
    const newPhaseModels = { ...currentPhaseModels, [phase]: value };
    if (provider) {
      await saveProviderAgentConfig(provider, { customPhaseModels: newPhaseModels });
    } else {
      await saveSettings({ customPhaseModels: newPhaseModels });
    }
  };

  const handlePhaseThinkingChange = async (phase: keyof PhaseThinkingConfig, value: ThinkingLevel) => {
    // Save as custom config (deviating from preset)
    const newPhaseThinking = { ...currentPhaseThinking, [phase]: value };
    if (provider) {
      await saveProviderAgentConfig(provider, { customPhaseThinking: newPhaseThinking });
    } else {
      await saveSettings({ customPhaseThinking: newPhaseThinking });
    }
  };

  const handleResetToProfileDefaults = async () => {
    // Reset to the selected profile's defaults
    if (provider) {
      await saveProviderAgentConfig(provider, {
        customPhaseModels: undefined,
        customPhaseThinking: undefined,
      });
    } else {
      await saveSettings({
        customPhaseModels: undefined,
        customPhaseThinking: undefined,
      });
    }
  };

  /**
   * Get human-readable model label
   */
  const getModelLabel = (modelValue: string): string => {
    const resolvedProvider = provider ?? activeProvider;
    if (resolvedProvider) {
      return getProviderModelLabel(modelValue, resolvedProvider);
    }
    const model = AVAILABLE_MODELS.find((m) => m.value === modelValue);
    return model?.label || modelValue;
  };

  /**
   * Get human-readable thinking level label
   */
  const getThinkingLabel = (thinkingValue: string): string => {
    const level = THINKING_LEVELS.find((l) => l.value === thinkingValue);
    return level?.label || thinkingValue;
  };

  // Summary of the selected profile shown under the profile switch:
  // "<description> · <model> · <thinking> thinking"
  const displayModel = providerPreset?.primaryModel ?? selectedProfile.model;
  const displayThinking = providerPreset?.primaryThinking ?? selectedProfile.thinkingLevel;
  const displayModelLabel = (() => {
    if (displayModel !== '') return getModelLabel(displayModel);
    // Ollama presets have no model until the user picks one
    const customModels = providerConfig?.customPhaseModels;
    const firstConfigured = customModels ? PHASE_KEYS.find((k) => customModels[k]) : undefined;
    return firstConfigured && customModels ? customModels[firstConfigured] : t('agentProfile.ollamaNotConfigured');
  })();
  const profileSummary = [
    selectedProfile.description,
    displayModelLabel,
    `${getThinkingLabel(displayThinking)} ${t('agentProfile.thinking').toLowerCase()}`,
    hasCustomConfig ? t('agentProfile.customized') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <SettingsSection title={t('agentProfile.title')}>
        <SettingsRows>
          {leadingRows}
          <SettingsRow label={t('agentProfile.profileRow')} description={profileSummary}>
            <SegmentedControl
              value={selectedProfile.id}
              options={DEFAULT_AGENT_PROFILES.map((profile) => ({ value: profile.id, label: profile.name }))}
              onValueChange={(profileId) => void handleSelectProfile(profileId)}
              ariaLabel={t('agentProfile.profileRow')}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      {/* Phase configuration: one row per phase, shared between all profiles */}
      <SettingsSection
        title={t('agentProfile.phaseConfiguration')}
        description={t('agentProfile.phaseConfigurationDescription')}
      >
        <SettingsRows>
          {PHASE_KEYS.map((phase) => (
            <SettingsRow
              key={phase}
              label={t(`agentProfile.phases.${phase}.label`)}
              description={
                <>
                  {t(`agentProfile.phases.${phase}.description`)}
                  <ReasoningTypeHint
                    withSeparator
                    modelValue={currentPhaseModels[phase]}
                    provider={provider ?? 'anthropic'}
                  />
                </>
              }
            >
              <MultiProviderModelSelect
                variant="inline"
                ariaLabel={t('agentProfile.model')}
                value={currentPhaseModels[phase]}
                onChange={(value) => handlePhaseModelChange(phase, value)}
                filterProvider={provider}
              />
              <ThinkingLevelSelect
                inline
                value={currentPhaseThinking[phase]}
                onChange={(value) => handlePhaseThinkingChange(phase, value as ThinkingLevel)}
                modelValue={currentPhaseModels[phase]}
                provider={provider ?? 'anthropic'}
              />
            </SettingsRow>
          ))}

          {/* Reset - shown when the phases deviate from the selected profile */}
          {hasCustomConfig && (
            <SettingsRow
              label={t('agentProfile.customized')}
              description={t('agentProfile.customizedDescription', { profile: selectedProfile.name })}
            >
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleResetToProfileDefaults}>
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('agentProfile.resetToDefaults')}
              </Button>
            </SettingsRow>
          )}
        </SettingsRows>
        <p className="mt-3 text-xs text-(--nav-label-color)">{t('agentProfile.phaseConfigNote')}</p>
      </SettingsSection>
    </>
  );
}
