import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingsRows } from './SettingsRow';
import { ThemeSelector } from './ThemeSelector';
import { DisplaySettings } from './DisplaySettings';
import { FontSettings } from './FontSettings';
import type { AppSettings } from '../../../shared/types';

interface ThemeSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Appearance section: the theme switch, the font rows, then the display rows (log order, GPU)
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
        <FontSettings settings={settings} onSettingsChange={onSettingsChange} />
        <DisplaySettings settings={settings} onSettingsChange={onSettingsChange} />
      </SettingsRows>
    </SettingsSection>
  );
}
