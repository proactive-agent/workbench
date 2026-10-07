import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { MultiProviderModelSelect } from './MultiProviderModelSelect';
import { ReasoningTypeHint, ThinkingLevelSelect } from './ThinkingLevelSelect';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { ALL_AVAILABLE_MODELS } from '@shared/constants/models';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import { PHASE_KEYS } from '@shared/constants/models';
import type { MixedPhaseConfig, MixedPhaseEntry, PipelinePhase, ThinkingLevel } from '@shared/types/settings';
import type { BuiltinProvider } from '@shared/types/provider-account';

/**
 * Default config used when customMixedPhaseConfig is not set.
 * All phases use Anthropic/opus/high.
 */
const DEFAULT_MIXED_PHASE_CONFIG: MixedPhaseConfig = {
  spec: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  planning: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  coding: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  qa: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
};

/**
 * Resolve the provider for a given model ID from ALL_AVAILABLE_MODELS.
 * Falls back to 'anthropic' if not found.
 */
function resolveProviderForModel(modelId: string): BuiltinProvider {
  const found = ALL_AVAILABLE_MODELS.find((m) => m.value === modelId);
  return found?.provider ?? 'anthropic';
}

/**
 * Get a short display name for a provider from PROVIDER_REGISTRY.
 */
function getProviderName(provider: BuiltinProvider): string {
  return PROVIDER_REGISTRY.find((p) => p.id === provider)?.name ?? provider;
}

/**
 * MixedPhaseEditor — shown when "Custom (Cross-Provider)" profile is active.
 *
 * Renders one row per pipeline phase (spec, planning, coding, qa).
 * Each row lets the user pick a model from any provider, a thinking level
 * adapted to that provider, and displays a provider badge.
 */
export function MixedPhaseEditor() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((s) => s.settings);

  const config: MixedPhaseConfig =
    settings.customMixedPhaseConfig ?? DEFAULT_MIXED_PHASE_CONFIG;

  const handleModelChange = async (phase: PipelinePhase, modelId: string) => {
    const provider = resolveProviderForModel(modelId);
    const current: MixedPhaseEntry = config[phase];

    const updatedEntry: MixedPhaseEntry = {
      ...current,
      provider,
      modelId,
    };

    await saveSettings({
      customMixedPhaseConfig: {
        ...config,
        [phase]: updatedEntry,
      },
    });
  };

  const handleThinkingChange = async (phase: PipelinePhase, thinkingLevel: ThinkingLevel) => {
    const current: MixedPhaseEntry = config[phase];

    await saveSettings({
      customMixedPhaseConfig: {
        ...config,
        [phase]: { ...current, thinkingLevel },
      },
    });
  };

  return (
    <SettingsRows>
      {(PHASE_KEYS as readonly PipelinePhase[]).map((phase) => {
        const entry = config[phase];

        return (
          <SettingsRow
            key={phase}
            label={t(`agentProfile.phases.${phase}.label` as Parameters<typeof t>[0])}
            description={
              <>
                {t(`agentProfile.phases.${phase}.description` as Parameters<typeof t>[0])}
                {' · '}
                {getProviderName(entry.provider)}
                <ReasoningTypeHint withSeparator modelValue={entry.modelId} provider={entry.provider} />
              </>
            }
          >
            {/* Model selector (all providers, no filtering) */}
            <MultiProviderModelSelect
              variant="inline"
              ariaLabel={t('agentProfile.model')}
              value={entry.modelId}
              onChange={(modelId) => handleModelChange(phase, modelId)}
            />

            {/* Thinking level selector, adapted to provider */}
            <ThinkingLevelSelect
              inline
              value={entry.thinkingLevel}
              onChange={(level) => handleThinkingChange(phase, level as ThinkingLevel)}
              modelValue={entry.modelId}
              provider={entry.provider}
            />
          </SettingsRow>
        );
      })}
    </SettingsRows>
  );
}
