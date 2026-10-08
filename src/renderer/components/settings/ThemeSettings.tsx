import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingsRows } from './SettingsRow';
import { ThemeSelector } from './ThemeSelector';
import { DisplaySettings } from './DisplaySettings';
import type { AppSettings } from '../../../shared/types';

interface ThemeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Appearance section: the theme switch followed by the display rows (scale, log order, GPU)
 */
export function ThemeSettings({ settings, onSettingsChange }: ThemeSettingsProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection
      title={t('theme.title')}
      description={t('theme.description')}
    >
      <SettingsRows>
        <ThemeSelector settings={settings} onSettingsChange={onSettingsChange} />
        <DisplaySettings settings={settings} onSettingsChange={onSettingsChange} />
      </SettingsRows>
    </SettingsSection>
  );
}
