import { useTranslation } from 'react-i18next';
import { Check, Sun, Moon, Monitor } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SettingsRow, SettingsRows, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { COLOR_THEMES, sanitizeColorTheme } from '../../../shared/constants';
import { useSettingsStore } from '../../stores/settings-store';
import type { ColorTheme, AppSettings } from '../../../shared/types';

interface ThemeSelectorProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Theme selector component displaying a grid of theme cards with preview swatches
 * and a 3-option mode toggle (Light/Dark/System)
 *
 * Theme changes are applied immediately for live preview, while other settings
 * require saving to take effect.
 */
export function ThemeSelector({ settings, onSettingsChange }: ThemeSelectorProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const currentColorTheme = sanitizeColorTheme(settings.colorTheme);
  const currentMode = settings.theme;
  const isDark = currentMode === 'dark' ||
    (currentMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const handleColorThemeChange = (themeId: ColorTheme) => {
    // Update local draft state
    onSettingsChange({ ...settings, colorTheme: themeId });
    // Apply immediately to store for live preview (triggers App.tsx useEffect)
    updateStoreSettings({ colorTheme: themeId });
  };

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
      {/* Mode Toggle */}
      <SettingsRow label={t('theme.mode')} description={t('theme.modeDescription')}>
        <SegmentedControl
          value={currentMode}
          options={modeOptions}
          onValueChange={handleModeChange}
          ariaLabel={t('theme.mode')}
        />
      </SettingsRow>

      {/* Color Theme Grid */}
      <SettingsRow
        label={t('theme.colorTheme')}
        description={t('theme.colorThemeDescription')}
        stacked
      >
        <div role="radiogroup" aria-label={t('theme.colorTheme')} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COLOR_THEMES.map((theme) => {
            const isSelected = currentColorTheme === theme.id;
            const bgColor = isDark ? theme.previewColors.darkBg : theme.previewColors.bg;
            const accentColor = isDark
              ? (theme.previewColors.darkAccent || theme.previewColors.accent)
              : theme.previewColors.accent;

            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => handleColorThemeChange(theme.id)}
                className={cn(
                  'relative flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
                  isSelected
                    ? 'border-foreground/30 bg-nav-active'
                    : 'border-border hover:bg-nav-hover'
                )}
              >
                {/* Preview swatches */}
                <div className="flex shrink-0 -space-x-1.5">
                  <div
                    className="h-5 w-5 rounded-full border border-border"
                    style={{ backgroundColor: bgColor }}
                  />
                  <div
                    className="h-5 w-5 rounded-full border border-border"
                    style={{ backgroundColor: accentColor }}
                  />
                </div>

                {/* Theme info */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{theme.name}</p>
                  <p className="truncate text-xs text-muted-foreground" title={theme.description}>{theme.description}</p>
                </div>

                {isSelected && <Check className="h-4 w-4 shrink-0 text-foreground" strokeWidth={2} />}
              </button>
            );
          })}
        </div>
      </SettingsRow>
    </SettingsRows>
  );
}
