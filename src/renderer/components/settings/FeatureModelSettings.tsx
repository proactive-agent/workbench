import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings-store';
import { saveProviderAgentConfig } from '../../stores/settings-store';
import { MultiProviderModelSelect } from './MultiProviderModelSelect';
import { ReasoningTypeHint, ThinkingLevelSelect } from './ThinkingLevelSelect';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
  FEATURE_LABELS,
} from '@shared/constants/models';
import type { BuiltinProvider } from '@shared/types/provider-account';
import type { FeatureModelConfig, ThinkingLevel } from '@shared/types/settings';

interface FeatureModelSettingsProps {
  provider: BuiltinProvider;
}

/**
 * Per-provider feature model configuration component.
 *
 * Renders a model selector and a thinking-level selector for each feature
 * (Insights, PR/MR review, Utility, Naming).
 *
 * Reads from `settings.providerAgentConfig[provider].featureModels` with
 * fallback to `settings.featureModels` then `DEFAULT_FEATURE_MODELS`.
 * Writes via `saveProviderAgentConfig`.
 */
export function FeatureModelSettings({ provider }: FeatureModelSettingsProps) {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((state) => state.settings);

  // For Ollama, default to empty strings — Anthropic model shorthands are meaningless
  const providerFeatureDefaults: FeatureModelConfig = provider === 'ollama'
    ? { insights: '', utility: '', naming: '' }
    : DEFAULT_FEATURE_MODELS;
  const providerThinkingDefaults = provider === 'ollama'
    ? { insights: 'low' as ThinkingLevel, utility: 'low' as ThinkingLevel, naming: 'low' as ThinkingLevel }
    : DEFAULT_FEATURE_THINKING;

  const featureModels: FeatureModelConfig =
    settings.providerAgentConfig?.[provider]?.featureModels ?? providerFeatureDefaults;

  const featureThinking =
    settings.providerAgentConfig?.[provider]?.featureThinking ?? providerThinkingDefaults;

  const handleModelChange = (feature: keyof FeatureModelConfig, value: string) => {
    saveProviderAgentConfig(provider, {
      featureModels: { ...featureModels, [feature]: value },
    });
  };

  const handleThinkingChange = (feature: keyof FeatureModelConfig, value: string) => {
    saveProviderAgentConfig(provider, {
      featureThinking: { ...featureThinking, [feature]: value as ThinkingLevel },
    });
  };

  return (
    <SettingsSection
      title={t('general.featureModelSettings')}
      description={t('general.featureModelSettingsDescription')}
    >
      <SettingsRows>
        {(Object.keys(FEATURE_LABELS) as Array<keyof FeatureModelConfig>).map((feature) => {
          const currentModel = featureModels[feature];
          const currentThinking = featureThinking[feature];

          return (
            <SettingsRow
              key={feature}
              label={FEATURE_LABELS[feature].label}
              description={
                <>
                  {FEATURE_LABELS[feature].description}
                  <ReasoningTypeHint withSeparator modelValue={currentModel} provider={provider} />
                </>
              }
            >
              <MultiProviderModelSelect
                variant="inline"
                ariaLabel={t('general.model')}
                value={currentModel}
                onChange={(value) => handleModelChange(feature, value)}
                filterProvider={provider}
              />
              <ThinkingLevelSelect
                inline
                value={currentThinking}
                onChange={(value) => handleThinkingChange(feature, value)}
                modelValue={currentModel}
                provider={provider}
              />
            </SettingsRow>
          );
        })}
      </SettingsRows>
    </SettingsSection>
  );
}
