import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../ui/input';
import { Combobox, ComboboxOption } from '../../ui/combobox';
import { SettingsRow, SettingsRows } from '../SettingsRow';
import { SettingsSlider, StepperButton } from './SettingsSlider';
import type { TerminalFontSettings } from '../../../stores/terminal-font-settings-store';
import { COMMON_MONOSPACE_FONTS } from '../../../lib/font-discovery';
import {
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_STEP,
  FONT_WEIGHT_MIN,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_STEP,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_STEP,
  LETTER_SPACING_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_STEP,
} from '../../../lib/terminal-font-constants';

interface FontConfigPanelProps {
  settings: TerminalFontSettings;
  onSettingChange: <K extends keyof TerminalFontSettings>(
    key: K,
    value: TerminalFontSettings[K]
  ) => void;
}

/**
 * Font configuration panel for terminal font customization.
 * Provides controls for:
 * - Font family (combobox with common monospace fonts)
 * - Font size (slider: 10-24px)
 * - Font weight (number input: 100-900)
 * - Line height (slider: 1.0-2.0)
 * - Letter spacing (slider: -2 to 5px)
 *
 * All changes apply immediately and persist via the parent store
 */
export function FontConfigPanel({ settings, onSettingChange }: FontConfigPanelProps) {
  const { t, i18n } = useTranslation('settings');

  // Locale-aware number formatter for decimals
  const numberFormatter = useMemo(() => {
    return new Intl.NumberFormat(i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    });
  }, [i18n.language]);

  // State for available fonts (will be populated from font-discovery)
  const [availableFonts, setAvailableFonts] = useState<ComboboxOption[]>([]);

  // Load available fonts on mount
  useEffect(() => {
    // Combine all common monospace fonts
    const allFonts = [
      ...COMMON_MONOSPACE_FONTS.windows,
      ...COMMON_MONOSPACE_FONTS.macos,
      ...COMMON_MONOSPACE_FONTS.linux,
      ...COMMON_MONOSPACE_FONTS.popular,
    ];

    // Remove duplicates and filter out 'monospace' generic
    const uniqueFonts = [...new Set(allFonts)].filter((f) => f.toLowerCase() !== 'monospace');

    // Convert to Combobox options
    const fontOptions: ComboboxOption[] = uniqueFonts.map((font) => ({
      value: font,
      label: font,
    }));

    setAvailableFonts(fontOptions);
  }, []);

  // Current font family (primary font from the array)
  const currentFontFamily = settings.fontFamily[0] || '';

  // Handle font family change
  const handleFontFamilyChange = (fontFamily: string) => {
    // Replace the entire font chain with the selected font as primary
    // Keep 'monospace' as ultimate fallback
    const newFontChain = [fontFamily, 'monospace'];
    onSettingChange('fontFamily', newFontChain);
  };

  // Handle font size change
  const handleFontSizeChange = (value: number) => {
    if (Number.isNaN(value)) return;
    const clampedValue = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value));
    onSettingChange('fontSize', clampedValue);
  };

  // Handle font weight change
  const handleFontWeightChange = (value: string) => {
    const numValue = parseInt(value, 10);
    if (Number.isNaN(numValue)) return;

    // Clamp to valid font weights (100-900, step of 100)
    const clampedValue = Math.max(FONT_WEIGHT_MIN, Math.min(FONT_WEIGHT_MAX, numValue));
    const steppedValue = Math.round(clampedValue / FONT_WEIGHT_STEP) * FONT_WEIGHT_STEP;

    onSettingChange('fontWeight', steppedValue);
  };

  // Handle line height change
  const handleLineHeightChange = (value: number) => {
    if (Number.isNaN(value)) return;
    const clampedValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, value));
    // Round to 1 decimal place
    const roundedValue = Math.round(clampedValue * 10) / 10;
    onSettingChange('lineHeight', roundedValue);
  };

  // Handle letter spacing change
  const handleLetterSpacingChange = (value: number) => {
    if (Number.isNaN(value)) return;
    const clampedValue = Math.max(LETTER_SPACING_MIN, Math.min(LETTER_SPACING_MAX, value));
    // Round to 1 decimal place
    const roundedValue = Math.round(clampedValue * 10) / 10;
    onSettingChange('letterSpacing', roundedValue);
  };

  const pixels = t('terminalFonts.fontConfig.pixels', { defaultValue: 'pixels' });
  const formatSpacing = (value: number) =>
    value > 0 ? `+${numberFormatter.format(value)}` : numberFormatter.format(value);

  return (
    <SettingsRows>
      {/* Font Family */}
      <SettingsRow
        label={t('terminalFonts.fontConfig.fontFamily', { defaultValue: 'Font family' })}
        description={
          <>
            {t('terminalFonts.fontConfig.fontFamilyDescription', {
              defaultValue: 'Primary monospace font for terminal text',
            })}
            <span className="mt-0.5 block text-xs">
              {t('terminalFonts.fontConfig.fontChain', { defaultValue: 'Font chain:' })}{' '}
              <code className="font-mono">{settings.fontFamily.join(', ')}</code>
            </span>
          </>
        }
      >
        <Combobox
          value={currentFontFamily}
          onValueChange={handleFontFamilyChange}
          options={availableFonts}
          placeholder={t('terminalFonts.fontConfig.selectFont', { defaultValue: 'Select a font...' })}
          searchPlaceholder={t('terminalFonts.fontConfig.searchFont', { defaultValue: 'Search fonts...' })}
          emptyMessage={t('terminalFonts.fontConfig.noFonts', { defaultValue: 'No fonts found' })}
          className="field-border h-8 w-56"
        />
      </SettingsRow>

      {/* Font Size */}
      <SettingsRow
        label={t('terminalFonts.fontConfig.fontSize', { defaultValue: 'Font size' })}
        description={t('terminalFonts.fontConfig.fontSizeDescription', {
          defaultValue: 'Base font size in pixels (10-24px)',
        })}
      >
        <SettingsSlider
          value={settings.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          onChange={handleFontSizeChange}
          parse={(raw) => parseInt(raw, 10)}
          ariaLabel={t('terminalFonts.fontConfig.fontSize', { defaultValue: 'Font size' })}
          ariaValueText={`${settings.fontSize} ${pixels}`}
          valueLabel={`${settings.fontSize}px`}
          onDecrease={() => handleFontSizeChange(settings.fontSize - FONT_SIZE_STEP)}
          onIncrease={() => handleFontSizeChange(settings.fontSize + FONT_SIZE_STEP)}
          decreaseTitle={t('terminalFonts.fontConfig.decreaseFontSize', { step: FONT_SIZE_STEP })}
          increaseTitle={t('terminalFonts.fontConfig.increaseFontSize', { step: FONT_SIZE_STEP })}
        />
      </SettingsRow>

      {/* Font Weight */}
      <SettingsRow
        label={t('terminalFonts.fontConfig.fontWeight', { defaultValue: 'Font weight' })}
        description={
          <>
            {t('terminalFonts.fontConfig.fontWeightDescription', {
              defaultValue: 'Font weight from 100 (thin) to 900 (black), in steps of 100',
            })}
            <span className="mt-0.5 block text-xs">
              {t('terminalFonts.fontConfig.commonWeights', {
                defaultValue: 'Common: 400 (normal), 600 (semi-bold), 700 (bold)',
              })}
            </span>
          </>
        }
      >
        <div className="flex items-center gap-0.5">
          <StepperButton
            direction="decrease"
            onClick={() => handleFontWeightChange((settings.fontWeight - FONT_WEIGHT_STEP).toString())}
            disabled={settings.fontWeight <= FONT_WEIGHT_MIN}
            title={t('terminalFonts.fontConfig.decreaseFontWeight', { step: FONT_WEIGHT_STEP })}
          />
          <Input
            type="number"
            min={FONT_WEIGHT_MIN}
            max={FONT_WEIGHT_MAX}
            step={FONT_WEIGHT_STEP}
            value={settings.fontWeight}
            onChange={(e) => handleFontWeightChange(e.target.value)}
            aria-label={t('terminalFonts.fontConfig.fontWeight', { defaultValue: 'Font weight' })}
            className="h-8 w-20 text-center font-mono"
          />
          <StepperButton
            direction="increase"
            onClick={() => handleFontWeightChange((settings.fontWeight + FONT_WEIGHT_STEP).toString())}
            disabled={settings.fontWeight >= FONT_WEIGHT_MAX}
            title={t('terminalFonts.fontConfig.increaseFontWeight', { step: FONT_WEIGHT_STEP })}
          />
        </div>
      </SettingsRow>

      {/* Line Height */}
      <SettingsRow
        label={t('terminalFonts.fontConfig.lineHeight', { defaultValue: 'Line height' })}
        description={t('terminalFonts.fontConfig.lineHeightDescription', {
          defaultValue: 'Line height as a multiple of font size (1.0-2.0)',
        })}
      >
        <SettingsSlider
          value={settings.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={LINE_HEIGHT_STEP}
          onChange={handleLineHeightChange}
          ariaLabel={t('terminalFonts.fontConfig.lineHeight', { defaultValue: 'Line height' })}
          ariaValueText={numberFormatter.format(settings.lineHeight)}
          valueLabel={numberFormatter.format(settings.lineHeight)}
          minLabel={LINE_HEIGHT_MIN.toFixed(1)}
          maxLabel={LINE_HEIGHT_MAX.toFixed(1)}
        />
      </SettingsRow>

      {/* Letter Spacing */}
      <SettingsRow
        label={t('terminalFonts.fontConfig.letterSpacing', { defaultValue: 'Letter spacing' })}
        description={t('terminalFonts.fontConfig.letterSpacingDescription', {
          defaultValue: 'Horizontal spacing between characters (-2 to 5px)',
        })}
      >
        <SettingsSlider
          value={settings.letterSpacing}
          min={LETTER_SPACING_MIN}
          max={LETTER_SPACING_MAX}
          step={LETTER_SPACING_STEP}
          onChange={handleLetterSpacingChange}
          ariaLabel={t('terminalFonts.fontConfig.letterSpacing', { defaultValue: 'Letter spacing' })}
          ariaValueText={`${formatSpacing(settings.letterSpacing)} ${pixels}`}
          valueLabel={`${formatSpacing(settings.letterSpacing)}px`}
          minLabel={`${LETTER_SPACING_MIN}px`}
          maxLabel={`+${LETTER_SPACING_MAX}px`}
        />
      </SettingsRow>
    </SettingsRows>
  );
}
