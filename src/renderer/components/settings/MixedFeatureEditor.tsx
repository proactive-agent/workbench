import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { MultiProviderModelSelect } from './MultiProviderModelSelect';
import { ReasoningTypeHint, ThinkingLevelSelect } from './ThinkingLevelSelect';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { ALL_AVAILABLE_MODELS, FEATURE_LABELS } from '@shared/constants/models';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import type { MixedFeatureConfig, MixedPhaseEntry, ThinkingLevel } from '@shared/types/settings';
import type { BuiltinProvider } from '@shared/types/provider-account';
import type { FeatureModelConfig } from '@shared/types/settings';

type FeatureKey = keyof FeatureModelConfig;

const FEATURE_KEYS: readonly FeatureKey[] = [
  'insights',
  'githubPrs',
  'utility',
] as const;

/**
 * Default config used when customMixedFeatureConfig is not set.
 */
const DEFAULT_MIXED_FEATURE_CONFIG: MixedFeatureConfig = {
  insights: { provider: 'anthropic', modelId: 'sonnet', thinkingLevel: 'medium' },
  githubPrs: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'medium' },
  utility: { provider: 'anthropic', modelId: 'haiku', thinkingLevel: 'low' },
  naming: { provider: 'anthropic', modelId: 'haiku', thinkingLevel: 'low' },
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
 * MixedFeatureEditor — shown in the Cross-Provider tab for feature model configuration.
 *
 * Renders one row per feature (insights, githubPrs, utility).
 * Each row lets the user pick a model from any provider, a thinking level
 * adapted to that provider, and displays a provider badge.
 */
export function MixedFeatureEditor() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((s) => s.settings);

  const config: MixedFeatureConfig =
    settings.customMixedFeatureConfig ?? DEFAULT_MIXED_FEATURE_CONFIG;

  const handleModelChange = async (feature: FeatureKey, modelId: string) => {
    const provider = resolveProviderForModel(modelId);
    const current: MixedPhaseEntry = config[feature];

    const updatedEntry: MixedPhaseEntry = {
      ...current,
      provider,
      modelId,
    };

    await saveSettings({
      customMixedFeatureConfig: {
        ...config,
        [feature]: updatedEntry,
      },
    });
  };

  const handleThinkingChange = async (feature: FeatureKey, thinkingLevel: ThinkingLevel) => {
    const current: MixedPhaseEntry = config[feature];

    await saveSettings({
      customMixedFeatureConfig: {
        ...config,
        [feature]: { ...current, thinkingLevel },
      },
    });
  };

  return (
    <SettingsRows>
      {FEATURE_KEYS.map((feature) => {
        const entry = config[feature];
        const featureLabel = FEATURE_LABELS[feature];

        return (
          <SettingsRow
            key={feature}
            label={featureLabel.label}
            description={
              <>
                {featureLabel.description}
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
              onChange={(modelId) => handleModelChange(feature, modelId)}
            />

            {/* Thinking level selector, adapted to provider */}
            <ThinkingLevelSelect
              inline
              value={entry.thinkingLevel}
              onChange={(level) => handleThinkingChange(feature, level as ThinkingLevel)}
              modelValue={entry.modelId}
              provider={entry.provider}
            />
          </SettingsRow>
        );
      })}
    </SettingsRows>
  );
}
