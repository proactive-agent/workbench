import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveProvider } from '../../hooks/useActiveProvider';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import type { BuiltinProvider } from '@shared/types/provider-account';
import { ProviderTabBar } from './ProviderTabBar';
import { AgentProfileSettings } from './AgentProfileSettings';
import { FeatureModelSettings } from './FeatureModelSettings';
import { CrossProviderTabContent } from './CrossProviderTabContent';
import { OllamaModelManager } from './OllamaModelManager';
import { SettingsSection } from './SettingsSection';
import { SettingsRow } from './SettingsRow';
import { saveSettings, useSettingsStore } from '../../stores/settings-store';

/**
 * ProviderAgentTabs
 *
 * Orchestrator wrapper for the entire agent settings section.
 * Shows a provider tab bar and renders agent/feature/override settings
 * scoped to the selected provider.
 */
export function ProviderAgentTabs() {
  const { t } = useTranslation('settings');
  const { connectedProviders, provider: activeProvider } = useActiveProvider();
  const settings = useSettingsStore((s) => s.settings);

  const needsSetup = useCallback((provider: BuiltinProvider): boolean => {
    if (provider !== 'ollama') return false;
    const ollamaConfig = settings.providerAgentConfig?.ollama;
    // Check phase models
    if (!ollamaConfig?.customPhaseModels) return true;
    const models = ollamaConfig.customPhaseModels;
    if (!models.spec && !models.planning && !models.coding && !models.qa) return true;
    // Check feature models — all must be set for the provider to be fully configured
    const featureModels = ollamaConfig.featureModels;
    if (!featureModels) return true;
    if (!featureModels.insights || !featureModels.utility) return true;
    return false;
  }, [settings.providerAgentConfig]);

  // Order: anthropic first, then remaining providers alphabetically
  const orderedProviders = useMemo<BuiltinProvider[]>(() => {
    const sorted = [...connectedProviders].sort((a, b) => a.localeCompare(b));
    const anthIdx = sorted.indexOf('anthropic');
    if (anthIdx > 0) {
      sorted.splice(anthIdx, 1);
      sorted.unshift('anthropic');
    }
    return sorted;
  }, [connectedProviders]);

  const [activeTab, setActiveTab] = useState<BuiltinProvider | 'cross-provider' | null>(activeProvider);

  // Keep active tab valid when providers change; fall back to first in list.
  // When cross-provider is active, resolvedTab is null (no provider selected).
  const resolvedTab: BuiltinProvider | null =
    activeTab === 'cross-provider'
      ? null
      : activeTab && orderedProviders.includes(activeTab)
        ? activeTab
        : orderedProviders[0] ?? null;

  const isCrossProviderActive = activeTab === 'cross-provider';

  if (orderedProviders.length === 0) {
    return (
      <SettingsSection title={t('agentProfile.title')}>
        <p className="rounded-xl bg-segment-track px-4 py-3 text-sm text-(--nav-label-color)">
          {t('agentProfile.providerTabs.noProviders')}
        </p>
      </SettingsSection>
    );
  }

  const providerDisplayName =
    resolvedTab !== null
      ? (PROVIDER_REGISTRY.find((p) => p.id === resolvedTab)?.name ?? resolvedTab)
      : '';

  // Provider switch: the first row of the "Agent profile" section
  const providerRow = (
    <SettingsRow
      label={t('agentProfile.providerTabs.label')}
      description={
        isCrossProviderActive
          ? t('agentProfile.customProfile.description')
          : t('agentProfile.providerTabs.configureFor', { provider: providerDisplayName })
      }
    >
      <ProviderTabBar
        providers={orderedProviders}
        activeProvider={resolvedTab}
        onProviderChange={(provider) => {
          if (isCrossProviderActive) {
            saveSettings({ customMixedProfileActive: false });
          }
          setActiveTab(provider);
        }}
        showCrossProvider
        isCrossProviderActive={isCrossProviderActive}
        onCrossProviderClick={() => setActiveTab('cross-provider')}
        crossProviderDisabled={connectedProviders.length < 2}
        needsSetup={needsSetup}
      />
    </SettingsRow>
  );

  if (isCrossProviderActive) {
    return <CrossProviderTabContent leadingRows={providerRow} />;
  }

  return (
    <>
      {/* Provider-scoped agent profile + phase settings */}
      <AgentProfileSettings provider={resolvedTab ?? undefined} leadingRows={providerRow} />

      {/* Provider-scoped feature model settings */}
      {resolvedTab && <FeatureModelSettings provider={resolvedTab} />}

      {/* Ollama model management */}
      {resolvedTab === 'ollama' && <OllamaModelManager />}
    </>
  );
}
