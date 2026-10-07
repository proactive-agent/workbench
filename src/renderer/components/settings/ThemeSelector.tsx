import { useTranslation } from 'react-i18next';
import { Sun, Moon, Monitor } from 'lucide-react';
import { SettingsRow, SettingsRows, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { useSettingsStore } from '../../stores/settings-store';
import type { AppSettings } from '../../../shared/types';

interface ThemeSelectorProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Theme settings row: an icon-only System / Light / Dark switch
 *
 * Theme changes are applied immediately for live preview, while other settings
 * require saving to take effect.
 */
export function ThemeSelector({ settings, onSettingsChange }: ThemeSelectorProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const currentMode = settings.theme;

  const handleModeChange = (mode: 'light' | 'dark' | 'system') => {
    // Update local draft state
    onSettingsChange({ ...settings, theme: mode });
    // Apply immediately to store for live preview (triggers App.tsx useEffect)
    updateStoreSettings({ theme: mode });
  };

  const modeOptions: SegmentedOption<'light' | 'dark' | 'system'>[] = [
    { value: 'system', label: t('theme.system'), icon: Monitor },
    { value: 'light', label: t('theme.light'), icon: Sun },
    { value: 'dark', label: t('theme.dark'), icon: Moon }
  ];

  return (
    <SettingsRows>
      {/* Theme: icon-only System / Light / Dark switch, like claude.ai */}
      <SettingsRow label={t('theme.mode')}>
        <SegmentedControl
          value={currentMode}
          options={modeOptions}
          onValueChange={handleModeChange}
          ariaLabel={t('theme.mode')}
          iconOnly
        />
      </SettingsRow>

    </SettingsRows>
  );
}
