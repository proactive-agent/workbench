import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { MixedPhaseEditor } from './MixedPhaseEditor';
import { MixedFeatureEditor } from './MixedFeatureEditor';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';

/**
 * CrossProviderTabContent — rendered when the user selects the "Cross-Provider" tab
 * in Agent Profile settings.
 *
 * Activates cross-provider mode on mount, then shows separate sections for
 * pipeline phase configuration (MixedPhaseEditor) and feature model configuration
 * (MixedFeatureEditor).
 */
interface CrossProviderTabContentProps {
  /** Rows rendered at the top of the "Agent profile" section (e.g. the provider switch) */
  leadingRows?: React.ReactNode;
}

export function CrossProviderTabContent({ leadingRows }: CrossProviderTabContentProps) {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((s) => s.settings);

  // Activate cross-provider mode when this tab is shown
  useEffect(() => {
    if (!settings.customMixedProfileActive) {
      saveSettings({ customMixedProfileActive: true });
    }
  }, []); // Only on mount

  return (
    <>
      <SettingsSection title={t('agentProfile.title')}>
        <SettingsRows>
          {leadingRows}
          <SettingsRow
            label={t('agentProfile.crossProviderTab.title')}
            description={`${t('agentProfile.crossProviderTab.description')} ${t('agentProfile.crossProviderTab.activateInfo')}`}
          />
        </SettingsRows>
      </SettingsSection>

      {/* Pipeline Phase Configuration */}
      <SettingsSection
        title={t('agentProfile.phaseConfiguration')}
        description={t('agentProfile.phaseConfigurationDescription')}
      >
        <MixedPhaseEditor />
      </SettingsSection>

      {/* Feature Model Configuration */}
      <SettingsSection
        title={t('agentProfile.crossProviderTab.featureModelsTitle')}
        description={t('agentProfile.crossProviderTab.featureModelsDescription')}
      >
        <MixedFeatureEditor />
      </SettingsSection>
    </>
  );
}
