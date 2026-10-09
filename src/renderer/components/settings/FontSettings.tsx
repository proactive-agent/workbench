import { useTranslation } from 'react-i18next';
import { SettingsRow, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { TerminalFontSettings } from './terminal-font-settings';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalFontSettingsStore } from '../../stores/terminal-font-settings-store';
import {
  INTERFACE_FONTS,
  INTERFACE_FONT_STACKS,
  TERMINAL_FONTS,
  TERMINAL_FONT_SIZES,
  terminalFontChain,
} from '../../lib/font-options';
import type { AppSettings, InterfaceFont } from '../../../shared/types';

interface FontSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Appearance font rows: the interface font, then the command line font and text size
 * (terminals and agent windows). Changes apply immediately.
 */
export function FontSettings({ settings, onSettingsChange }: FontSettingsProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const fontFamily = useTerminalFontSettingsStore((state) => state.fontFamily);
  const fontSize = useTerminalFontSettingsStore((state) => state.fontSize);
  const applyTerminalSettings = useTerminalFontSettingsStore((state) => state.applySettings);

  const interfaceFont = settings.interfaceFont ?? 'anthropic-sans';

  const handleInterfaceFontChange = (font: InterfaceFont) => {
    onSettingsChange({ ...settings, interfaceFont: font });
    updateStoreSettings({ interfaceFont: font });
  };

  // Segmented options for a set of numeric values, labelled by translation key
  const numberOptions = (values: Record<string, number>, labelPrefix: string): SegmentedOption<string>[] =>
    Object.entries(values).map(([key, value]) => ({ value: String(value), label: t(`${labelPrefix}.${key}`) }));

  return (
    <>
      <SettingsRow
        label={t('fonts.interfaceFont')}
        description={t('fonts.interfaceFontDescription')}
        htmlFor="interfaceFont"
      >
        <Select value={interfaceFont} onValueChange={(value) => handleInterfaceFontChange(value as InterfaceFont)}>
          <SelectTrigger id="interfaceFont" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERFACE_FONTS.map((font) => (
              <SelectItem key={font} value={font} style={{ fontFamily: INTERFACE_FONT_STACKS[font] ?? undefined }}>
                {t(`fonts.interfaceFonts.${font}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        label={t('fonts.terminalFont')}
        description={t('fonts.terminalFontDescription')}
        htmlFor="terminalFont"
      >
        <Select
          value={fontFamily[0] ?? ''}
          onValueChange={(font) => applyTerminalSettings({ fontFamily: terminalFontChain(font) })}
        >
          <SelectTrigger id="terminalFont" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TERMINAL_FONTS.map((font) => (
              <SelectItem key={font} value={font} style={{ fontFamily: terminalFontChain(font).join(', ') }}>
                {font}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t('fonts.textSize')} description={t('fonts.textSizeDescription')}>
        <SegmentedControl
          value={String(fontSize)}
          options={numberOptions(TERMINAL_FONT_SIZES, 'fonts.textSizes')}
          onValueChange={(value) => applyTerminalSettings({ fontSize: Number(value) })}
          ariaLabel={t('fonts.textSize')}
        />
      </SettingsRow>

      {/* Cursor style, scrollback limit, and import/export of the terminal settings */}
      <TerminalFontSettings />
    </>
  );
}
