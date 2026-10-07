import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Input } from '../ui/input';
import { useSettingsStore } from '../../stores/settings-store';
import type { SupportedIDE, SupportedTerminal, SupportedCLI } from '../../../shared/types';

interface DevToolsStepProps {
  onNext: () => void;
  onBack: () => void;
}

interface DetectedTool {
  id: string;
  name: string;
  path: string;
  installed: boolean;
}

interface DetectedTools {
  ides: DetectedTool[];
  terminals: DetectedTool[];
  clis: DetectedTool[];
}

// IDE display names - alphabetically sorted for easy scanning
const IDE_NAMES: Partial<Record<SupportedIDE, string>> = {
  androidstudio: 'Android Studio',
  clion: 'CLion',
  cursor: 'Cursor',
  emacs: 'Emacs',
  goland: 'GoLand',
  intellij: 'IntelliJ IDEA',
  neovim: 'Neovim',
  nova: 'Nova',
  phpstorm: 'PhpStorm',
  pycharm: 'PyCharm',
  rider: 'Rider',
  rubymine: 'RubyMine',
  sublime: 'Sublime Text',
  vim: 'Vim',
  vscode: 'Visual Studio Code',
  vscodium: 'VSCodium',
  webstorm: 'WebStorm',
  windsurf: 'Windsurf',
  xcode: 'Xcode',
  zed: 'Zed',
  custom: 'Custom...'  // Always last
};

// Terminal display names - alphabetically sorted
const TERMINAL_NAMES: Partial<Record<SupportedTerminal, string>> = {
  alacritty: 'Alacritty',
  ghostty: 'Ghostty',
  gnometerminal: 'GNOME Terminal',
  hyper: 'Hyper',
  iterm2: 'iTerm2',
  kitty: 'Kitty',
  konsole: 'Konsole',
  powershell: 'PowerShell',
  system: 'System Terminal',
  tabby: 'Tabby',
  terminal: 'Terminal.app',
  terminator: 'Terminator',
  tilix: 'Tilix',
  tmux: 'tmux',
  warp: 'Warp',
  wezterm: 'WezTerm',
  windowsterminal: 'Windows Terminal',
  zellij: 'Zellij',
  custom: 'Custom...'  // Always last
};

// CLI display names
const CLI_NAMES: Partial<Record<SupportedCLI, string>> = {
  'claude-code': 'Claude Code',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  kilocode: 'Kilo Code CLI',
  codex: 'Codex CLI',
  custom: 'Custom...'
};

/**
 * Developer Tools configuration step for the onboarding wizard.
 *
 * Detects installed IDEs and terminals, allows the user to select
 * their preferred tools for opening worktrees.
 */
export function DevToolsStep({ onNext, onBack }: DevToolsStepProps) {
  const { t } = useTranslation('onboarding');
  const { settings, updateSettings } = useSettingsStore();
  const [preferredIDE, setPreferredIDE] = useState<SupportedIDE>(settings.preferredIDE || 'vscode');
  const [preferredTerminal, setPreferredTerminal] = useState<SupportedTerminal>(settings.preferredTerminal || 'system');
  const [customIDEPath, setCustomIDEPath] = useState(settings.customIDEPath || '');
  const [customTerminalPath, setCustomTerminalPath] = useState(settings.customTerminalPath || '');
  const [preferredCLI, setPreferredCLI] = useState<SupportedCLI>(settings.preferredCLI || 'claude-code');
  const [customCLIPath, setCustomCLIPath] = useState(settings.customCLIPath || '');

  const [detectedTools, setDetectedTools] = useState<DetectedTools | null>(null);
  const [isDetecting, setIsDetecting] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect installed tools on mount
  const detectTools = useCallback(async () => {
    setIsDetecting(true);
    try {
      // Check if the API is available (may not be in dev mode or if preload failed)
      if (!window.electronAPI?.worktreeDetectTools) {
        console.warn('[DevToolsStep] Detection API not available, using fallback');
        setIsDetecting(false);
        return;
      }

      const result = await window.electronAPI.worktreeDetectTools();
      if (result.success && result.data) {
        setDetectedTools(result.data as DetectedTools);

        // Auto-select the first detected IDE if none is configured
        if (!settings.preferredIDE && result.data.ides.length > 0) {
          setPreferredIDE(result.data.ides[0].id as SupportedIDE);
        }
      }
    } catch (err) {
      console.error('Failed to detect tools:', err);
    } finally {
      setIsDetecting(false);
    }
  }, [settings.preferredIDE]);

  useEffect(() => {
    detectTools();
  }, [detectTools]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const settingsToSave = {
        preferredIDE,
        preferredTerminal,
        customIDEPath: preferredIDE === 'custom' ? customIDEPath : undefined,
        customTerminalPath: preferredTerminal === 'custom' ? customTerminalPath : undefined,
        preferredCLI,
        customCLIPath: preferredCLI === 'custom' ? customCLIPath : undefined
      };

      const result = await window.electronAPI.saveSettings(settingsToSave);

      if (result?.success) {
        updateSettings(settingsToSave);
        onNext();
      } else {
        setError(result?.error || 'Failed to save settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  // Build IDE options with detection status
  const ideOptions: Array<{ value: SupportedIDE; label: string; detected: boolean }> = [];

  // Add detected IDEs first
  if (detectedTools) {
    for (const tool of detectedTools.ides) {
      ideOptions.push({
        value: tool.id as SupportedIDE,
        label: tool.name,
        detected: true
      });
    }
  }

  // Add remaining IDEs that weren't detected
  const detectedIDEIds = new Set(detectedTools?.ides.map(t => t.id) || []);
  for (const [id, name] of Object.entries(IDE_NAMES)) {
    if (id !== 'custom' && !detectedIDEIds.has(id)) {
      ideOptions.push({
        value: id as SupportedIDE,
        label: name,
        detected: false
      });
    }
  }

  // Add custom option last
  ideOptions.push({ value: 'custom', label: 'Custom...', detected: false });

  // Build Terminal options with detection status
  const terminalOptions: Array<{ value: SupportedTerminal; label: string; detected: boolean }> = [];

  // Always add system terminal first
  terminalOptions.push({
    value: 'system',
    label: TERMINAL_NAMES.system || 'System Terminal',
    detected: true
  });

  // Add detected terminals
  if (detectedTools) {
    for (const tool of detectedTools.terminals) {
      if (tool.id !== 'system') {
        terminalOptions.push({
          value: tool.id as SupportedTerminal,
          label: tool.name,
          detected: true
        });
      }
    }
  }

  // Add remaining terminals that weren't detected
  const detectedTerminalIds = new Set(detectedTools?.terminals.map(t => t.id) || []);
  detectedTerminalIds.add('system');
  for (const [id, name] of Object.entries(TERMINAL_NAMES)) {
    if (id !== 'custom' && !detectedTerminalIds.has(id)) {
      terminalOptions.push({
        value: id as SupportedTerminal,
        label: name,
        detected: false
      });
    }
  }

  // Add custom option last
  terminalOptions.push({ value: 'custom', label: 'Custom...', detected: false });

  // Build CLI options with detection status
  const cliOptions: Array<{ value: SupportedCLI; label: string; detected: boolean }> = [];

  // Add detected CLIs first
  if (detectedTools?.clis) {
    for (const tool of detectedTools.clis) {
      cliOptions.push({
        value: tool.id as SupportedCLI,
        label: tool.name,
        detected: true
      });
    }
  }

  // Add remaining CLIs that weren't detected
  const detectedCLIIds = new Set(detectedTools?.clis?.map(t => t.id) || []);
  for (const [id, name] of Object.entries(CLI_NAMES)) {
    if (id !== 'custom' && !detectedCLIIds.has(id)) {
      cliOptions.push({
        value: id as SupportedCLI,
        label: name,
        detected: false
      });
    }
  }

  // Add custom option last
  cliOptions.push({ value: 'custom', label: 'Custom...', detected: false });

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-6">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">
            {t('devtools.title')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t('devtools.description')}
          </p>
        </div>

        {/* Loading state */}
        {isDetecting && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('devtools.detecting')}
          </div>
        )}

        {/* Main content */}
        {!isDetecting && (
          <div className="space-y-4">
            {/* Error */}
            {error && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}

            {/* Info */}
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <p className="text-foreground">
                {t('devtools.whyConfigure')}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t('devtools.whyConfigureDescription')}
              </p>
            </div>

            <SettingsRows>
              <SettingsRow
                label={t('devtools.ide.label')}
                description={t('devtools.ide.description')}
                footer={
                  preferredIDE === 'custom' ? (
                    <div className="space-y-2">
                      <Label htmlFor="custom-ide-path">{t('devtools.ide.customPath')}</Label>
                      <Input
                        id="custom-ide-path"
                        value={customIDEPath}
                        onChange={(e) => setCustomIDEPath(e.target.value)}
                        placeholder="/path/to/your/ide"
                        disabled={isSaving}
                      />
                    </div>
                  ) : undefined
                }
              >
                <Select
                  value={preferredIDE}
                  onValueChange={(value: SupportedIDE) => setPreferredIDE(value)}
                  disabled={isSaving}
                >
                  <SelectTrigger aria-label={t('devtools.ide.label')}>
                    <SelectValue placeholder={t('devtools.ide.placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {ideOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        // Tools that weren't detected can't be picked ("Custom..." always can)
                        disabled={!option.detected && option.value !== 'custom'}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>

              <SettingsRow
                label={t('devtools.terminal.label')}
                description={t('devtools.terminal.description')}
                footer={
                  preferredTerminal === 'custom' ? (
                    <div className="space-y-2">
                      <Label htmlFor="custom-terminal-path">{t('devtools.terminal.customPath')}</Label>
                      <Input
                        id="custom-terminal-path"
                        value={customTerminalPath}
                        onChange={(e) => setCustomTerminalPath(e.target.value)}
                        placeholder="/path/to/your/terminal"
                        disabled={isSaving}
                      />
                    </div>
                  ) : undefined
                }
              >
                <Select
                  value={preferredTerminal}
                  onValueChange={(value: SupportedTerminal) => setPreferredTerminal(value)}
                  disabled={isSaving}
                >
                  <SelectTrigger aria-label={t('devtools.terminal.label')}>
                    <SelectValue placeholder={t('devtools.terminal.placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {terminalOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        // Tools that weren't detected can't be picked ("Custom..." always can)
                        disabled={!option.detected && option.value !== 'custom'}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>

              <SettingsRow
                label={t('devtools.cli.label')}
                description={t('devtools.cli.description')}
                footer={
                  preferredCLI === 'custom' ? (
                    <div className="space-y-2">
                      <Label htmlFor="custom-cli-path">{t('devtools.cli.customPath')}</Label>
                      <Input
                        id="custom-cli-path"
                        value={customCLIPath}
                        onChange={(e) => setCustomCLIPath(e.target.value)}
                        placeholder="/path/to/your/cli"
                        disabled={isSaving}
                      />
                    </div>
                  ) : undefined
                }
              >
                <Select
                  value={preferredCLI}
                  onValueChange={(value: SupportedCLI) => setPreferredCLI(value)}
                  disabled={isSaving}
                >
                  <SelectTrigger aria-label={t('devtools.cli.label')}>
                    <SelectValue placeholder={t('devtools.cli.placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {cliOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        // Tools that weren't detected can't be picked ("Custom..." always can)
                        disabled={!option.detected && option.value !== 'custom'}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            </SettingsRows>

            <div className="flex items-start justify-between gap-4">
              {/* Detection summary */}
              {detectedTools && (
                <div className="text-sm text-muted-foreground">
                  <p className="text-foreground mb-1">{t('devtools.detectedSummary')}</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {detectedTools.ides.map((ide) => (
                      <li key={ide.id}>{ide.name}</li>
                    ))}
                    {detectedTools.terminals.filter(t => t.id !== 'system').map((term) => (
                      <li key={term.id}>{term.name}</li>
                    ))}
                    {detectedTools.clis?.filter(c => c.installed).map((cli) => (
                      <li key={cli.id}>{cli.name}</li>
                    ))}
                    {detectedTools.ides.length === 0 && detectedTools.terminals.filter(t => t.id !== 'system').length === 0 && (!detectedTools.clis || detectedTools.clis.length === 0) && (
                      <li>{t('devtools.noToolsDetected')}</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Detect again */}
              <Button
                variant="outline"
                size="sm"
                onClick={detectTools}
                disabled={isDetecting}
                className="ml-auto shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('devtools.detectAgain')}
              </Button>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex justify-between items-center mt-10 pt-6 border-t border-settings-divider">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
          >
            {t('common:buttons.back', 'Back')}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isDetecting || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                {t('common:buttons.saving', 'Saving...')}
              </>
            ) : (
              t('devtools.saveAndContinue')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
