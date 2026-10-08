import { Copy, Download, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useToast } from '../../../hooks/use-toast';
import { Button } from '../../ui/button';
import { SettingsSection } from '../SettingsSection';
import { SettingsRow, SettingsRows } from '../SettingsRow';
import { useTerminalFontSettingsStore } from '../../../stores/terminal-font-settings-store';
import type { TerminalFontSettings } from '../../../stores/terminal-font-settings-store';
import { MAX_IMPORT_FILE_SIZE } from '../../../lib/terminal-font-constants';

// Child components
import { CursorConfigPanel } from './CursorConfigPanel';
import { PerformanceConfigPanel } from './PerformanceConfigPanel';

/**
 * Terminal font settings main container component
 * Orchestrates all terminal font customization panels:
 * - Cursor configuration (style, blink, accent color)
 * - Performance settings (scrollback limit)
 * - Quick presets (VS Code, IntelliJ, macOS, Ubuntu)
 * - Live preview terminal (real-time updates, 300ms debounced)
 *
 * All settings persist via localStorage through the Zustand store
 * Changes apply immediately to all active terminal instances
 */
export function TerminalFontSettings() {
  const { t } = useTranslation('settings');
  const { toast } = useToast();

  // Get current settings from store using individual selectors to prevent infinite re-render loop
  // Each selector only re-renders when its specific value changes
  const fontFamily = useTerminalFontSettingsStore((state) => state.fontFamily);
  const fontSize = useTerminalFontSettingsStore((state) => state.fontSize);
  const fontWeight = useTerminalFontSettingsStore((state) => state.fontWeight);
  const lineHeight = useTerminalFontSettingsStore((state) => state.lineHeight);
  const letterSpacing = useTerminalFontSettingsStore((state) => state.letterSpacing);
  const cursorStyle = useTerminalFontSettingsStore((state) => state.cursorStyle);
  const cursorBlink = useTerminalFontSettingsStore((state) => state.cursorBlink);
  const cursorAccentColor = useTerminalFontSettingsStore((state) => state.cursorAccentColor);
  const scrollback = useTerminalFontSettingsStore((state) => state.scrollback);

  // Reconstruct settings object with stable reference using useMemo
  // This prevents the infinite re-render loop caused by creating new object references
  const settings = useMemo<TerminalFontSettings>(
    () => ({
      fontFamily,
      fontSize,
      fontWeight,
      lineHeight,
      letterSpacing,
      cursorStyle,
      cursorBlink,
      cursorAccentColor,
      scrollback,
    }),
    [fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, cursorStyle, cursorBlink, cursorAccentColor, scrollback]
  );

  // Get action methods from store
  const updateSettings = useTerminalFontSettingsStore((state) => state.applySettings);
  const exportSettings = useTerminalFontSettingsStore((state) => state.exportSettings);
  const importSettings = useTerminalFontSettingsStore((state) => state.importSettings);

  /**
   * Handle individual setting updates
   * This wrapper ensures type safety and could add validation/logging in future
   */
  const handleSettingChange = <K extends keyof TerminalFontSettings>(
    key: K,
    value: TerminalFontSettings[K]
  ) => {
    updateSettings({ [key]: value });
  };

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
    <div>

      <SettingsSection title={t('terminalFonts.cursorConfig.title', { defaultValue: 'Cursor' })}>
        <CursorConfigPanel settings={settings} onSettingChange={handleSettingChange} />
      </SettingsSection>

      <SettingsSection title={t('terminalFonts.performanceConfig.title', { defaultValue: 'Scrollback' })}>
        <PerformanceConfigPanel settings={settings} onSettingChange={handleSettingChange} />
      </SettingsSection>

      {/* Settings as JSON: export, import, copy */}
      <SettingsSection title={t('terminalFonts.importExport.title', { defaultValue: 'Configuration' })}>
        <SettingsRows>
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
        </SettingsRows>
      </SettingsSection>
    </div>
  );
}
