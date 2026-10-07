import { useTranslation } from 'react-i18next';
import { SettingsRow, SettingsRows, SegmentedControl, type SegmentedOption } from '../SettingsRow';
import { SettingsSlider } from './SettingsSlider';
import type { TerminalFontSettings } from '../../../stores/terminal-font-settings-store';
import { SCROLLBACK_MIN, SCROLLBACK_MAX, SCROLLBACK_STEP } from '../../../lib/terminal-font-constants';

interface PerformanceConfigPanelProps {
  settings: TerminalFontSettings;
  onSettingChange: <K extends keyof TerminalFontSettings>(
    key: K,
    value: TerminalFontSettings[K]
  ) => void;
}

/**
 * Performance configuration panel for terminal scrollback settings.
 * Provides controls for:
 * - Quick preset buttons (1K, 10K, 50K, 100K lines)
 * - Fine-tune slider (1K-100K lines in 1K increments)
 *
 * All changes apply immediately and persist via the parent store
 */
export function PerformanceConfigPanel({ settings, onSettingChange }: PerformanceConfigPanelProps) {
  const { t } = useTranslation('settings');

  // Format scrollback value for display (e.g., 10000 -> "10K")
  const formatScrollback = (value: number): string => {
    if (value >= 1000) {
      return t('terminalFonts.performanceConfig.kValue', {
        defaultValue: '{{value}}K',
        value: value / 1000,
      });
    }
    return value.toString();
  };

  // Preset scrollback values with labels (defined inside component to access t())
  const scrollbackPresets = [
    {
      value: 1000,
      label: formatScrollback(1000),
      description: t('terminalFonts.performanceConfig.presetMinimal', { defaultValue: 'Minimal' }),
    },
    {
      value: 10000,
      label: formatScrollback(10000),
      description: t('terminalFonts.performanceConfig.presetStandard', { defaultValue: 'Standard' }),
    },
    {
      value: 50000,
      label: formatScrollback(50000),
      description: t('terminalFonts.performanceConfig.presetExtended', { defaultValue: 'Extended' }),
    },
    {
      value: 100000,
      label: formatScrollback(100000),
      description: t('terminalFonts.performanceConfig.presetMaximum', { defaultValue: 'Maximum' }),
    },
  ] as const;

  // Handle scrollback change
  const handleScrollbackChange = (value: number) => {
    if (Number.isNaN(value)) return;
    const clampedValue = Math.max(SCROLLBACK_MIN, Math.min(SCROLLBACK_MAX, value));
    // Round to nearest 1K
    const steppedValue = Math.round(clampedValue / SCROLLBACK_STEP) * SCROLLBACK_STEP;
    onSettingChange('scrollback', steppedValue);
  };

  // Handle preset button clicks - apply immediately
  const handlePresetChange = (newScrollback: number) => {
    onSettingChange('scrollback', newScrollback);
  };

  const presetOptions: SegmentedOption<string>[] = scrollbackPresets.map((preset) => ({
    value: String(preset.value),
    label: preset.label,
  }));
  const matchesPreset = scrollbackPresets.some((preset) => preset.value === settings.scrollback);

  return (
    <SettingsRows>
      {/* Preset values */}
      <SettingsRow
        label={t('terminalFonts.performanceConfig.presets', { defaultValue: 'Quick presets' })}
        description={t('terminalFonts.performanceConfig.presetsDescription', {
          defaultValue: 'Common scrollback limits for different use cases',
        })}
      >
        {/* Remount when the value leaves/enters the preset list so the thumb hides/reappears */}
        <SegmentedControl
          key={matchesPreset ? 'preset' : 'custom'}
          value={String(settings.scrollback)}
          options={presetOptions}
          onValueChange={(value) => handlePresetChange(Number(value))}
          ariaLabel={t('terminalFonts.performanceConfig.presets', { defaultValue: 'Quick presets' })}
        />
      </SettingsRow>

      {/* Fine-tune Slider */}
      <SettingsRow
        label={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
        description={t('terminalFonts.performanceConfig.scrollbackDescription', {
          defaultValue: 'Maximum number of lines to keep in terminal history (1K-100K)',
        })}
      >
        <SettingsSlider
          value={settings.scrollback}
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          step={SCROLLBACK_STEP}
          onChange={handleScrollbackChange}
          parse={(raw) => parseInt(raw, 10)}
          ariaLabel={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
          ariaValueText={t('terminalFonts.performanceConfig.scrollbackValue', {
            defaultValue: '{{value}} lines',
            value: formatScrollback(settings.scrollback),
          })}
          valueLabel={formatScrollback(settings.scrollback)}
          onDecrease={() => handleScrollbackChange(settings.scrollback - SCROLLBACK_STEP)}
          onIncrease={() => handleScrollbackChange(settings.scrollback + SCROLLBACK_STEP)}
          decreaseTitle={t('terminalFonts.performanceConfig.decreaseScrollback', { step: formatScrollback(SCROLLBACK_STEP) })}
          increaseTitle={t('terminalFonts.performanceConfig.increaseScrollback', { step: formatScrollback(SCROLLBACK_STEP) })}
        />
      </SettingsRow>
    </SettingsRows>
  );
}
