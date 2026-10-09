/**
 * AgentProfileSelector - Reusable component for selecting agent profile in forms
 *
 * Provides a dropdown for quick profile selection (Auto, Complex, Balanced, Quick)
 * with an inline "Custom" option that reveals model and thinking level selects.
 * The "Auto" profile shows per-phase model configuration.
 *
 * Used in TaskCreationWizard and TaskEditDialog.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useOllamaLlmModels } from '../hooks/useOllamaLlmModels';
import { useActiveProvider } from '../hooks/useActiveProvider';
import { getProviderModelLabel } from '../../shared/utils/model-display';
import { Brain, Scale, Zap, Sliders, Sparkles } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { ThinkingLevelSelect, ReasoningTypeHint } from './settings/ThinkingLevelSelect';
import { SettingsRow, SettingsRows } from './settings/SettingsRow';
import {
  DEFAULT_AGENT_PROFILES,
  AVAILABLE_MODELS,
  ALL_AVAILABLE_MODELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
} from '../../shared/constants';
import type { ModelType, ThinkingLevel } from '../../shared/types';
import type { PhaseModelConfig, PhaseThinkingConfig } from '../../shared/types/settings';

interface AgentProfileSelectorProps {
  /** Currently selected profile ID ('auto', 'complex', 'balanced', 'quick', or 'custom') */
  profileId: string;
  /** Current model value (fallback for non-auto profiles) */
  model: ModelType | '';
  /** Current thinking level value (fallback for non-auto profiles) */
  thinkingLevel: ThinkingLevel | '';
  /** Phase model configuration (for auto profile) */
  phaseModels?: PhaseModelConfig;
  /** Phase thinking configuration (for auto profile) */
  phaseThinking?: PhaseThinkingConfig;
  /** Called when profile selection changes */
  onProfileChange: (profileId: string, model: ModelType, thinkingLevel: ThinkingLevel) => void;
  /** Called when model changes (in custom mode) */
  onModelChange: (model: ModelType) => void;
  /** Called when thinking level changes (in custom mode) */
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  /** Called when phase models change (in auto mode) */
  onPhaseModelsChange?: (phaseModels: PhaseModelConfig) => void;
  /** Called when phase thinking changes (in auto mode) */
  onPhaseThinkingChange?: (phaseThinking: PhaseThinkingConfig) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

const iconMap: Record<string, React.ElementType> = {
  Brain,
  Scale,
  Zap,
  Sparkles
};

// Phase label translation keys
const PHASE_LABEL_KEYS: Record<keyof PhaseModelConfig, { label: string; description: string }> = {
  spec: { label: 'agentProfile.phases.spec.label', description: 'agentProfile.phases.spec.description' },
  planning: { label: 'agentProfile.phases.planning.label', description: 'agentProfile.phases.planning.description' },
  coding: { label: 'agentProfile.phases.coding.label', description: 'agentProfile.phases.coding.description' },
  qa: { label: 'agentProfile.phases.qa.label', description: 'agentProfile.phases.qa.description' }
};

export function AgentProfileSelector({
  profileId,
  model,
  thinkingLevel,
  phaseModels,
  phaseThinking,
  onProfileChange,
  onModelChange,
  onThinkingLevelChange,
  onPhaseModelsChange,
  onPhaseThinkingChange,
  disabled
}: AgentProfileSelectorProps) {
  const { t } = useTranslation('settings');
  const { provider: activeProvider } = useActiveProvider();

  // Ollama models are user-installed: the saved list (fetched once if never fetched)
  const { models: installedOllamaModels } = useOllamaLlmModels(activeProvider === 'ollama');
  const ollamaModels = useMemo(
    () => installedOllamaModels.map((m) => ({ value: m.name, label: m.name })),
    [installedOllamaModels]
  );

  const isCustom = profileId === 'custom';
  const _isAuto = profileId === 'auto';

  // Use provided phase configs or defaults
  const currentPhaseModels = phaseModels || DEFAULT_PHASE_MODELS;
  const currentPhaseThinking = phaseThinking || DEFAULT_PHASE_THINKING;

  // Build model options filtered to the active provider (falls back to Anthropic models)
  const phaseModelOptions = useMemo(() => {
    if (!activeProvider || activeProvider === 'anthropic') {
      return AVAILABLE_MODELS.map(m => ({ value: m.value, label: m.label }));
    }
    // Ollama: use dynamically fetched installed models
    if (activeProvider === 'ollama' && ollamaModels.length > 0) {
      return ollamaModels;
    }
    const providerModels = ALL_AVAILABLE_MODELS.filter(m => m.provider === activeProvider);
    if (providerModels.length === 0) {
      return AVAILABLE_MODELS.map(m => ({ value: m.value, label: m.label }));
    }
    return providerModels.map(m => ({ value: m.value, label: m.label }));
  }, [activeProvider, ollamaModels]);

  const handleProfileSelect = (selectedId: string) => {
    if (selectedId === 'custom') {
      // Keep current model/thinking level, just mark as custom
      onProfileChange('custom', model as ModelType || 'sonnet', thinkingLevel as ThinkingLevel || 'medium');
      return;
    }
    // Select preset profile - all profiles now have phase configs
    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === selectedId);
    if (profile) {
      onProfileChange(profile.id, profile.model, profile.thinkingLevel);
      // Initialize phase configs with profile defaults if callbacks provided
      if (onPhaseModelsChange && profile.phaseModels) {
        onPhaseModelsChange(profile.phaseModels);
      }
      if (onPhaseThinkingChange && profile.phaseThinking) {
        onPhaseThinkingChange(profile.phaseThinking);
      }
    }
  };

  const handlePhaseModelChange = (phase: keyof PhaseModelConfig, value: ModelType) => {
    if (onPhaseModelsChange) {
      onPhaseModelsChange({
        ...currentPhaseModels,
        [phase]: value
      });
    }
  };

  const handlePhaseThinkingChange = (phase: keyof PhaseThinkingConfig, value: ThinkingLevel) => {
    if (onPhaseThinkingChange) {
      onPhaseThinkingChange({
        ...currentPhaseThinking,
        [phase]: value
      });
    }
  };

  // Get profile display info
  const getProfileDisplay = () => {
    if (isCustom) {
      return {
        icon: Sliders,
        label: t('agentProfile.customConfiguration'),
        description: t('agentProfile.customDescription')
      };
    }
    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === profileId);
    if (profile) {
      return {
        icon: iconMap[profile.icon || 'Scale'] || Scale,
        label: profile.name,
        description: profile.description
      };
    }
    // Default to auto profile (the actual default)
    return {
      icon: Sparkles,
      label: 'Auto (Optimized)',
      description: 'Uses Opus across all phases with optimized thinking levels'
    };
  };

  const display = getProfileDisplay();

  return (
    <SettingsRows>
      {/* Agent profile: select in the row's control slot (borderless) */}
      <SettingsRow label={t('agentProfile.label')} description={display.description} htmlFor="agent-profile">
        <Select value={profileId} onValueChange={handleProfileSelect} disabled={disabled}>
          <SelectTrigger id="agent-profile" className="h-8 w-auto">
            <SelectValue>
              <span className="flex items-center gap-2">
                <display.icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                <span>{display.label}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {DEFAULT_AGENT_PROFILES.map((profile) => {
              const ProfileIcon = iconMap[profile.icon || 'Scale'] || Scale;
              const modelLabel = activeProvider
                ? getProviderModelLabel(profile.model, activeProvider)
                : AVAILABLE_MODELS.find(m => m.value === profile.model)?.label;
              return (
                <SelectItem key={profile.id} value={profile.id}>
                  <div className="flex items-center gap-2">
                    <ProfileIcon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <div>
                      <span>{profile.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({modelLabel} + {profile.thinkingLevel})
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
            <SelectItem value="custom">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <div>
                  <span>{t('agentProfile.custom')}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({t('agentProfile.customDescription')})
                  </span>
                </div>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>

      {/* Phase configuration - one row per phase for all preset profiles */}
      {!isCustom &&
        (Object.keys(PHASE_LABEL_KEYS) as Array<keyof PhaseModelConfig>).map((phase) => (
          <SettingsRow
            key={phase}
            label={t(PHASE_LABEL_KEYS[phase].label)}
            description={
              <>
                {t(PHASE_LABEL_KEYS[phase].description)}
                <ReasoningTypeHint
                  withSeparator
                  modelValue={currentPhaseModels[phase]}
                  provider={activeProvider ?? 'anthropic'}
                />
              </>
            }
          >
            <Select
              value={currentPhaseModels[phase]}
              onValueChange={(value) => handlePhaseModelChange(phase, value as ModelType)}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-auto" aria-label={t('agentProfile.model')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {phaseModelOptions.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ThinkingLevelSelect
              inline
              value={currentPhaseThinking[phase]}
              onChange={(value) => handlePhaseThinkingChange(phase, value as ThinkingLevel)}
              modelValue={currentPhaseModels[phase]}
              provider={activeProvider ?? 'anthropic'}
              disabled={disabled}
            />
          </SettingsRow>
        ))}

      {/* Custom configuration (shown only when custom is selected) */}
      {isCustom && (
        <SettingsRow
          label={t('agentProfile.model')}
          htmlFor="custom-model"
          description={
            <ReasoningTypeHint modelValue={model || 'sonnet'} provider={activeProvider ?? 'anthropic'} />
          }
        >
          <Select
            value={model}
            onValueChange={(value) => onModelChange(value as ModelType)}
            disabled={disabled}
          >
            <SelectTrigger id="custom-model" className="h-8 w-auto">
              <SelectValue placeholder={t('agentProfile.selectModel')} />
            </SelectTrigger>
            <SelectContent align="end">
              {phaseModelOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ThinkingLevelSelect
            inline
            value={thinkingLevel || 'low'}
            onChange={(value) => onThinkingLevelChange(value as ThinkingLevel)}
            modelValue={model || 'sonnet'}
            provider={activeProvider ?? 'anthropic'}
            disabled={disabled}
          />
        </SettingsRow>
      )}
    </SettingsRows>
  );
}
