import { Copy, Download, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../../hooks/use-toast';
import { Button } from '../../ui/button';
import { SettingsRow, SegmentedControl, type SegmentedOption } from '../SettingsRow';
import { useTerminalFontSettingsStore } from '../../../stores/terminal-font-settings-store';
import type { TerminalFontSettings as TerminalSettingsValues } from '../../../stores/terminal-font-settings-store';
import { MAX_IMPORT_FILE_SIZE } from '../../../lib/terminal-font-constants';
import { SCROLLBACK_PRESETS } from '../../../lib/font-options';


/**
 * Terminal rows for General > Appearance (after the command line font rows): cursor style,
 * scrollback limit, and import/export of the terminal settings as JSON. Values live in the
 * terminal settings store (localStorage) and apply to open terminals immediately.
 */
export function TerminalFontSettings() {
  const { t } = useTranslation('settings');
  const { toast } = useToast();

  const cursorStyle = useTerminalFontSettingsStore((state) => state.cursorStyle);
  const scrollback = useTerminalFontSettingsStore((state) => state.scrollback);
  const applySettings = useTerminalFontSettingsStore((state) => state.applySettings);
  const handleSettingChange = <K extends keyof TerminalSettingsValues>(key: K, value: TerminalSettingsValues[K]) => {
    applySettings({ [key]: value });
  };

  const cursorStyleOptions: SegmentedOption<TerminalSettingsValues['cursorStyle']>[] = [
    { value: 'block', label: t('terminalFonts.cursorConfig.styleBlock', { defaultValue: 'Block' }) },
    { value: 'underline', label: t('terminalFonts.cursorConfig.styleUnderline', { defaultValue: 'Underline' }) },
    { value: 'bar', label: t('terminalFonts.cursorConfig.styleBar', { defaultValue: 'Bar' }) },
  ];
  const scrollbackOptions: SegmentedOption<string>[] = SCROLLBACK_PRESETS.map((value) => ({
    value: String(value),
    label: t('terminalFonts.performanceConfig.kValue', { defaultValue: '{{value}}K', value: value / 1000 }),
  }));

  const exportSettings = useTerminalFontSettingsStore((state) => state.exportSettings);
  const importSettings = useTerminalFontSettingsStore((state) => state.importSettings);

  /**
   * Handle export configuration to JSON file
   */
  const handleExport = () => {
    try {
      const json = exportSettings();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'terminal-font-settings.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: t('terminalFonts.importExport.exportSuccess', { defaultValue: 'Settings exported successfully' }),
      });
    } catch (error) {
      console.error('Failed to export settings:', error);
      toast({
        variant: 'destructive',
        title: t('terminalFonts.importExport.exportFailed', { defaultValue: 'Failed to export settings' }),
      });
    }
  };

  /**
   * Handle import configuration from JSON file
   */
  const handleImport = (file: File) => {
    // Check file size
    if (file.size > MAX_IMPORT_FILE_SIZE) {
      toast({
        variant: 'destructive',
        title: t('terminalFonts.importExport.fileTooLarge', { defaultValue: 'Import file too large (max 10KB)' }),
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = e.target?.result as string;
        const success = importSettings(json);

        if (success) {
          toast({
            title: t('terminalFonts.importExport.importSuccess', { defaultValue: 'Settings imported successfully' }),
          });
        } else {
          toast({
            variant: 'destructive',
            title: t('terminalFonts.importExport.importFailed', { defaultValue: 'Failed to import settings: Invalid JSON format' }),
            description: t('terminalFonts.importExport.importFailedRange', { defaultValue: 'Values must be within valid ranges' }),
          });
        }
      } catch (error) {
        console.error('Failed to import settings:', error);
        toast({
          variant: 'destructive',
          title: t('terminalFonts.importExport.readError', { defaultValue: 'Failed to read file' }),
        });
      }
    };

    reader.onerror = () => {
      toast({
        variant: 'destructive',
        title: t('terminalFonts.importExport.readError', { defaultValue: 'Failed to read file' }),
      });
    };

    reader.readAsText(file);
  };

  /**
   * Handle copy configuration to clipboard
   */
  const handleCopyToClipboard = async () => {
    try {
      const json = exportSettings();
      await navigator.clipboard.writeText(json);

      toast({
        title: t('terminalFonts.importExport.copySuccess', { defaultValue: 'Settings copied to clipboard' }),
      });
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      toast({
        variant: 'destructive',
        title: t('terminalFonts.importExport.copyFailed', { defaultValue: 'Failed to copy to clipboard' }),
      });
    }
  };

  return (
    <>
      <SettingsRow
        label={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        description={t('terminalFonts.cursorConfig.cursorStyleDescription', {
          defaultValue: 'Choose the appearance of the terminal cursor',
        })}
      >
        <SegmentedControl
          value={cursorStyle}
          options={cursorStyleOptions}
          onValueChange={(value) => handleSettingChange('cursorStyle', value)}
          ariaLabel={t('terminalFonts.cursorConfig.cursorStyle', { defaultValue: 'Cursor style' })}
        />
      </SettingsRow>

      <SettingsRow
        label={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
        description={t('terminalFonts.performanceConfig.scrollbackDescription', {
          defaultValue: 'Maximum number of lines to keep in terminal history',
        })}
      >
        <SegmentedControl
          value={String(scrollback)}
          options={scrollbackOptions}
          onValueChange={(value) => handleSettingChange('scrollback', Number(value))}
          ariaLabel={t('terminalFonts.performanceConfig.scrollback', { defaultValue: 'Scrollback limit' })}
        />
      </SettingsRow>

      {/* Settings as JSON: export, import, copy */}
      <SettingsRow
        label={t('terminalFonts.importExport.label', { defaultValue: 'Import and export' })}
        description={t('terminalFonts.importExport.description', {
          defaultValue: 'Save, load or copy your terminal settings as JSON',
        })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
            {t('terminalFonts.export', { defaultValue: 'Export JSON' })}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <label className="cursor-pointer focus-within:shadow-(--shadow-focus)">
              <Upload className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
              {t('terminalFonts.import', { defaultValue: 'Import JSON' })}
              <input
                type="file"
                accept=".json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleImport(file);
                    e.target.value = ''; // Reset to allow re-importing same file
                  }
                }}
              />
            </label>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleCopyToClipboard}>
            <Copy className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
            {t('terminalFonts.copy', { defaultValue: 'Copy to clipboard' })}
          </Button>
        </div>
      </SettingsRow>
    </>
  );
}
