import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Switch } from '../../ui/switch';
import { SettingsRow, SettingsRows, SegmentedControl, type SegmentedOption } from '../SettingsRow';
import type { TerminalFontSettings } from '../../../stores/terminal-font-settings-store';

interface CursorConfigPanelProps {
  settings: TerminalFontSettings;
  onSettingChange: <K extends keyof TerminalFontSettings>(
    key: K,
    value: TerminalFontSettings[K]
  ) => void;
}

/**
 * Cursor configuration panel for terminal cursor customization.
 * Provides controls for:
 * - Cursor style (select: block/underline/bar)
 * - Cursor blink (switch: on/off)
 * - Cursor accent color (color picker)
 *
 * All changes apply immediately and persist via the parent store
 */
export function CursorConfigPanel({ settings, onSettingChange }: CursorConfigPanelProps) {
  const { t } = useTranslation('settings');

  // Cursor style options (defined inside component to access t())
  const cursorStyles = [
    {
      value: 'block' as const,
      label: t('terminalFonts.cursorConfig.styleBlock', { defaultValue: 'Block' }),
      description: t('terminalFonts.cursorConfig.styleBlockDescription', { defaultValue: 'Full block cursor' }),
    },
    {
      value: 'underline' as const,
      label: t('terminalFonts.cursorConfig.styleUnderline', { defaultValue: 'Underline' }),
      description: t('terminalFonts.cursorConfig.styleUnderlineDescription', { defaultValue: 'Underline cursor' }),
    },
    {
      value: 'bar' as const,
      label: t('terminalFonts.cursorConfig.styleBar', { defaultValue: 'Bar' }),
      description: t('terminalFonts.cursorConfig.styleBarDescription', { defaultValue: 'Vertical bar cursor' }),
    },
  ];

  // Handle cursor style change
  const handleCursorStyleChange = (value: 'block' | 'underline' | 'bar') => {
    onSettingChange('cursorStyle', value);
  };

  // Handle cursor blink change
  const handleCursorBlinkChange = (checked: boolean) => {
    onSettingChange('cursorBlink', checked);
  };

  // Handle cursor accent color change
  const handleCursorAccentColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const color = event.target.value;
    onSettingChange('cursorAccentColor', color);
  };

  const cursorStyleOptions: SegmentedOption<'block' | 'underline' | 'bar'>[] = cursorStyles.map((style) => ({
    value: style.value,
    label: style.label,
  }));

  return (
    <SettingsRows>
      {/* Cursor Style */}
      <SettingsRow
        label={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        description={t('terminalFonts.cursorConfig.cursorStyleDescription', {
          defaultValue: 'Choose the appearance of the terminal cursor',
        })}
      >
        <SegmentedControl
          value={settings.cursorStyle}
          options={cursorStyleOptions}
          onValueChange={handleCursorStyleChange}
          ariaLabel={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        />
      </SettingsRow>

      {/* Cursor Blink */}
      <SettingsRow
        label={t('terminalFonts.cursorConfig.cursorBlink', { defaultValue: 'Cursor blink' })}
        description={t('terminalFonts.cursorConfig.cursorBlinkDescription', {
          defaultValue: 'Enable or disable cursor blinking animation',
        })}
        htmlFor="cursor-blink"
      >
        <Switch id="cursor-blink" checked={settings.cursorBlink} onCheckedChange={handleCursorBlinkChange} />
      </SettingsRow>

      {/* Cursor Accent Color */}
      <SettingsRow
        label={t('terminalFonts.cursorConfig.cursorAccentColor', { defaultValue: 'Cursor accent color' })}
        description={
          <span id="cursor-color-description">
            {t('terminalFonts.cursorConfig.cursorAccentColorDescription', {
              defaultValue: 'Choose the color of the terminal cursor',
            })}
          </span>
        }
      >
        <label
          className={cn(
            'relative flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-segment-track pl-1.5 pr-3',
            'shadow-[inset_0_0_0_1px_var(--segment-thumb-ring)] focus-within:shadow-(--shadow-focus)'
          )}
          title={t('terminalFonts.cursorConfig.pickColor', { defaultValue: 'Click to pick a color' })}
        >
          <span
            aria-hidden="true"
            className="h-5 w-5 rounded-md shadow-[inset_0_0_0_1px_var(--segment-thumb-ring)]"
            style={{ backgroundColor: settings.cursorAccentColor }}
          />
          <span className="font-mono text-sm text-foreground">{settings.cursorAccentColor.toUpperCase()}</span>
          <input
            type="color"
            id="cursor-accent-color"
            value={settings.cursorAccentColor}
            onChange={handleCursorAccentColorChange}
            aria-label={t('terminalFonts.cursorConfig.cursorAccentColor', { defaultValue: 'Cursor accent color' })}
            aria-describedby="cursor-color-description"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onSettingChange('cursorAccentColor', '#000000')}
          title={t('terminalFonts.cursorConfig.resetColor', { defaultValue: 'Reset to black' })}
        >
          {t('terminalFonts.cursorConfig.reset', { defaultValue: 'Reset' })}
        </Button>
      </SettingsRow>
    </SettingsRows>
  );
}
