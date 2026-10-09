import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Loader2, FolderOpen } from 'lucide-react';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import type { AppSettings, SupportedIDE, SupportedTerminal, SupportedCLI } from '../../../shared/types';

const TOOLS_CACHE_KEY = 'detected-tools';

interface DevToolsSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
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

// CLI display names
const CLI_NAMES: Partial<Record<SupportedCLI, string>> = {
  'claude-code': 'Claude Code',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  kilocode: 'Kilo Code CLI',
  codex: 'Codex CLI',
  custom: 'Custom...'
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

/**
 * Developer Tools settings component for configuring preferred IDE and terminal
 */
export function DevToolsSettings({ settings, onSettingsChange }: DevToolsSettingsProps) {
  const { t } = useTranslation('settings');
  const [detectedTools, setDetectedTools] = useState<DetectedTools | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  // Detect installed IDEs and terminals
  const detectTools = useCallback(async () => {
    setIsDetecting(true);
    setDetectError(null);
    try {
      // Check if the API is available (may not be in dev mode or if preload failed)
      if (!window.electronAPI?.worktreeDetectTools) {
        console.warn('[DevToolsSettings] Detection API not available');
        setIsDetecting(false);
        return;
      }

      const result = await window.electronAPI.worktreeDetectTools();
      if (result.success && result.data) {
        setDetectedTools(result.data as DetectedTools);
        writeRefreshCache(TOOLS_CACHE_KEY, result.data);
      } else {
        setDetectError(result.error || 'Failed to detect tools');
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Failed to detect tools');
    } finally {
      setIsDetecting(false);
    }
  }, []);

  // Show the last detection; only detect on Refresh (or when it never ran)
  useEffect(() => {
    const cached = readRefreshCache<DetectedTools>(TOOLS_CACHE_KEY);
    if (cached) {
      setDetectedTools(cached);
    } else {
      void detectTools();
    }
  }, [detectTools]);

  const handleIDEChange = (ide: SupportedIDE) => {
    onSettingsChange({
      ...settings,
      preferredIDE: ide,
      // Clear custom path when switching away from custom
      customIDEPath: ide === 'custom' ? settings.customIDEPath : undefined
    });
  };

  const handleTerminalChange = (terminal: SupportedTerminal) => {
    onSettingsChange({
      ...settings,
      preferredTerminal: terminal,
      // Clear custom path when switching away from custom
      customTerminalPath: terminal === 'custom' ? settings.customTerminalPath : undefined
    });
  };

  const handleCustomIDEPathChange = (path: string) => {
    onSettingsChange({
      ...settings,
      customIDEPath: path
    });
  };

  const handleCustomTerminalPathChange = (path: string) => {
    onSettingsChange({
      ...settings,
      customTerminalPath: path
    });
  };

  const handleCLIChange = (cli: SupportedCLI) => {
    onSettingsChange({
      ...settings,
      preferredCLI: cli,
      customCLIPath: cli === 'custom' ? settings.customCLIPath : undefined
    });
  };

  const handleCustomCLIPathChange = (path: string) => {
    onSettingsChange({
      ...settings,
      customCLIPath: path
    });
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
  detectedTerminalIds.add('system'); // Always consider system as detected
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

  if (detectedTools?.clis) {
    for (const tool of detectedTools.clis) {
      cliOptions.push({
        value: tool.id as SupportedCLI,
        label: tool.name,
        detected: true
      });
    }
  }

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

  cliOptions.push({ value: 'custom', label: 'Custom...', detected: false });

  const noToolsDetected = !!detectedTools &&
    detectedTools.ides.length === 0 &&
    detectedTools.terminals.filter(t => t.id !== 'system').length === 0 &&
    (!detectedTools.clis || detectedTools.clis.length === 0);

  return (
    <SettingsSection
      title={t('devtools.title', 'Developer tools')}
      description={t('devtools.description', 'Configure your preferred IDE and terminal for working with worktrees')}
    >
      {detectError && <p className="mb-2 text-sm text-destructive">{detectError}</p>}

      <SettingsRows>
        <SettingsRow
          label={t('devtools.ide.label', 'Preferred IDE')}
          description={t('devtools.ide.description', 'Auto Claude will open worktrees in this editor')}
          htmlFor="preferred-ide"
          footer={
            settings.preferredIDE === 'custom' ? (
              <div className="space-y-2">
                <Label htmlFor="custom-ide-path" className="text-xs font-normal text-muted-foreground">
                  {t('devtools.customPath', 'Custom path')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-ide-path"
                    value={settings.customIDEPath || ''}
                    onChange={(e) => handleCustomIDEPathChange(e.target.value)}
                    placeholder="/path/to/your/ide"
                    className="h-8 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-8 px-0"
                    onClick={async () => {
                      const result = await window.electronAPI.selectDirectory();
                      if (result) {
                        handleCustomIDEPathChange(result);
                      }
                    }}
                    aria-label={t('common:accessibility.browseFilesAriaLabel')}
                  >
                    <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          <Select
            value={settings.preferredIDE || 'vscode'}
            onValueChange={(value) => handleIDEChange(value as SupportedIDE)}
          >
            <SelectTrigger id="preferred-ide" className="h-8 w-56">
              <SelectValue placeholder={t('devtools.ide.placeholder', 'Select IDE...')} />
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
          label={t('devtools.terminal.label', 'Preferred terminal')}
          description={t('devtools.terminal.description', 'Auto Claude will open terminal sessions here')}
          htmlFor="preferred-terminal"
          footer={
            settings.preferredTerminal === 'custom' ? (
              <div className="space-y-2">
                <Label htmlFor="custom-terminal-path" className="text-xs font-normal text-muted-foreground">
                  {t('devtools.customPath', 'Custom path')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-terminal-path"
                    value={settings.customTerminalPath || ''}
                    onChange={(e) => handleCustomTerminalPathChange(e.target.value)}
                    placeholder="/path/to/your/terminal"
                    className="h-8 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-8 px-0"
                    onClick={async () => {
                      const result = await window.electronAPI.selectDirectory();
                      if (result) {
                        handleCustomTerminalPathChange(result);
                      }
                    }}
                    aria-label={t('common:accessibility.browseFilesAriaLabel')}
                  >
                    <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          <Select
            value={settings.preferredTerminal || 'system'}
            onValueChange={(value) => handleTerminalChange(value as SupportedTerminal)}
          >
            <SelectTrigger id="preferred-terminal" className="h-8 w-56">
              <SelectValue placeholder={t('devtools.terminal.placeholder', 'Select terminal...')} />
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
          label={t('devtools.cli.label', 'Preferred CLI')}
          description={t('devtools.cli.description', 'CLI tool used for AI-powered terminal sessions')}
          htmlFor="preferred-cli"
          footer={
            settings.preferredCLI === 'custom' ? (
              <div className="space-y-2">
                <Label htmlFor="custom-cli-path" className="text-xs font-normal text-muted-foreground">
                  {t('devtools.customPath', 'Custom path')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-cli-path"
                    value={settings.customCLIPath || ''}
                    onChange={(e) => handleCustomCLIPathChange(e.target.value)}
                    placeholder="/path/to/your/cli"
                    className="h-8 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-8 px-0"
                    onClick={async () => {
                      const result = await window.electronAPI.selectDirectory();
                      if (result) {
                        handleCustomCLIPathChange(result);
                      }
                    }}
                    aria-label={t('common:accessibility.browseFilesAriaLabel')}
                  >
                    <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            ) : undefined
          }
        >
          <Select
            value={settings.preferredCLI || 'claude-code'}
            onValueChange={(value) => handleCLIChange(value as SupportedCLI)}
          >
            <SelectTrigger id="preferred-cli" className="h-8 w-56">
              <SelectValue placeholder={t('devtools.cli.placeholder', 'Select CLI...')} />
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

        {/* YOLO Mode Toggle */}
        <SettingsRow
          label={t('devtools.yoloMode.label', 'YOLO mode')}
          description={
            <>
              {t('devtools.yoloMode.description', 'Start Claude with --dangerously-skip-permissions flag, bypassing all safety prompts. Use with extreme caution')}
              {settings.dangerouslySkipPermissions && (
                <span className="mt-1 block text-xs text-destructive">
                  {t('devtools.yoloMode.warning', 'This mode bypasses Claude\'s permission system. Only enable if you fully trust the code being executed')}
                </span>
              )}
            </>
          }
          htmlFor="yolo-mode"
        >
          <Switch
            id="yolo-mode"
            checked={settings.dangerouslySkipPermissions ?? false}
            onCheckedChange={(checked) => {
              onSettingsChange({
                ...settings,
                dangerouslySkipPermissions: checked
              });
            }}
          />
        </SettingsRow>

        {/* Detection Summary */}
        <SettingsRow
          label={t('devtools.detected', 'Detected on your system')}
          description={detectedTools && !isDetecting ? (
            noToolsDetected ? (
              t('devtools.noToolsDetected', 'No additional tools detected')
            ) : (
              [
                ...detectedTools.ides.map((ide) => ide.name),
                ...detectedTools.terminals.filter(t => t.id !== 'system').map((term) => term.name),
                ...(detectedTools.clis?.filter(c => c.installed).map((cli) => cli.name) ?? [])
              ].join(', ')
            )
          ) : undefined}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={detectTools}
            disabled={isDetecting}
          >
            {isDetecting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            {t('devtools.detectAgain', 'Detect again')}
          </Button>
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
