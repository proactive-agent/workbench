import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { ProviderAgentTabs } from './ProviderAgentTabs';
import { ClaudeCodeSettings } from './ClaudeCodeSettings';
import { DEFAULT_MAX_TERMINALS, MIN_TERMINALS, MAX_TERMINALS_LIMIT } from '../../../shared/constants';
import type {
  AppSettings,
  ToolDetectionResult
} from '../../../shared/types';

interface GeneralSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'agent' | 'paths';
}

/**
 * Helper component to display auto-detected CLI tool information
 */
interface ToolDetectionDisplayProps {
  info: ToolDetectionResult | null;
  isLoading: boolean;
  t: (key: string) => string;
}

function ToolDetectionDisplay({ info, isLoading, t }: ToolDetectionDisplayProps) {
  if (isLoading) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('general.detecting')}
      </div>
    );
  }

  if (!info || !info.found) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('general.notDetected')}
      </div>
    );
  }

  const getSourceLabel = (source: ToolDetectionResult['source']): string => {
    const sourceMap: Record<ToolDetectionResult['source'], string> = {
      'user-config': t('general.sourceUserConfig'),
      'venv': t('general.sourceVenv'),
      'homebrew': t('general.sourceHomebrew'),
      'nvm': t('general.sourceNvm'),
      'system-path': t('general.sourceSystemPath'),
      'bundled': t('general.sourceBundled'),
      'fallback': t('general.sourceFallback'),
    };
    return sourceMap[source] || source;
  };

  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      <div>
        <span className="font-medium">{t('general.detectedPath')}:</span>{' '}
        <code className="bg-muted px-1 py-0.5 rounded">{info.path}</code>
      </div>
      {info.version && (
        <div>
          <span className="font-medium">{t('general.detectedVersion')}:</span>{' '}
          {info.version}
        </div>
      )}
      <div>
        <span className="font-medium">{t('general.detectedSource')}:</span>{' '}
        {getSourceLabel(info.source)}
      </div>
    </div>
  );
}

/**
 * General settings component for agent configuration and paths
 */
export function GeneralSettings({ settings, onSettingsChange, section }: GeneralSettingsProps) {
  const { t } = useTranslation('settings');
  const [toolsInfo, setToolsInfo] = useState<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    glab: ToolDetectionResult;
    claude: ToolDetectionResult;
  } | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);

  // Fetch CLI tools detection info when component mounts (paths section only)
  useEffect(() => {
    if (section === 'paths') {
      setIsLoadingTools(true);
      window.electronAPI
        .getCliToolsInfo()
        .then((result: { success: boolean; data?: { python: ToolDetectionResult; git: ToolDetectionResult; gh: ToolDetectionResult; glab: ToolDetectionResult; claude: ToolDetectionResult } }) => {
          if (result.success && result.data) {
            setToolsInfo(result.data);
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to fetch CLI tools info:', error);
        })
        .finally(() => {
          setIsLoadingTools(false);
        });
    }
  }, [section]);

  if (section === 'agent') {
    return (
      <div className="space-y-8">
        {/* Provider-tabbed agent settings (profiles, features, model overrides) */}
        <ProviderAgentTabs />

        {/* Claude Code CLI (status, install/update, version and installation switching) */}
        <ClaudeCodeSettings />

        {/* Other Agent Settings */}
        <SettingsSection
          title={t('general.otherAgentSettings')}
          description={t('general.otherAgentSettingsDescription')}
        >
          <SettingsRows>
            <SettingsRow
              label={t('general.agentFramework')}
              description={t('general.agentFrameworkDescription')}
              htmlFor="agentFramework"
            >
              <Select
                value={settings.agentFramework}
                onValueChange={(value) => onSettingsChange({ ...settings, agentFramework: value })}
              >
                <SelectTrigger id="agentFramework" className="h-8 w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto-claude">{t('general.agentFrameworkAutoClaude')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow
              label={t('general.aiTerminalNaming')}
              description={t('general.aiTerminalNamingDescription')}
              htmlFor="autoNameTerminals"
            >
              <Switch
                id="autoNameTerminals"
                checked={settings.autoNameTerminals}
                onCheckedChange={(checked) => onSettingsChange({ ...settings, autoNameTerminals: checked })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('general.maxTerminals')}
              description={t('general.maxTerminalsDescription', { min: MIN_TERMINALS, max: MAX_TERMINALS_LIMIT })}
              htmlFor="maxTerminals"
            >
              <Input
                id="maxTerminals"
                type="number"
                min={MIN_TERMINALS}
                max={MAX_TERMINALS_LIMIT}
                className="w-20"
                value={settings.maxTerminals ?? DEFAULT_MAX_TERMINALS}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (e.target.value === '' || !Number.isFinite(value)) return;
                  const clamped = Math.min(MAX_TERMINALS_LIMIT, Math.max(MIN_TERMINALS, Math.round(value)));
                  onSettingsChange({ ...settings, maxTerminals: clamped });
                }}
              />
            </SettingsRow>
          </SettingsRows>
        </SettingsSection>
      </div>
    );
  }

  // paths section
  return (
    <SettingsSection
      title={t('general.paths')}
      description={t('general.pathsDescription')}
    >
      <SettingsRows>
        <SettingsRow
          label={t('general.pythonPath')}
          description={t('general.pythonPathDescription')}
          htmlFor="pythonPath"
          stacked
          footer={!settings.pythonPath ? (
            <ToolDetectionDisplay
              info={toolsInfo?.python || null}
              isLoading={isLoadingTools}
              t={t}
            />
          ) : undefined}
        >
          <Input
            id="pythonPath"
            placeholder={t('general.pythonPathPlaceholder')}
            className="h-9 w-full"
            value={settings.pythonPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, pythonPath: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('general.gitPath')}
          description={t('general.gitPathDescription')}
          htmlFor="gitPath"
          stacked
          footer={!settings.gitPath ? (
            <ToolDetectionDisplay
              info={toolsInfo?.git || null}
              isLoading={isLoadingTools}
              t={t}
            />
          ) : undefined}
        >
          <Input
            id="gitPath"
            placeholder={t('general.gitPathPlaceholder')}
            className="h-9 w-full"
            value={settings.gitPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, gitPath: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('general.githubCLIPath')}
          description={t('general.githubCLIPathDescription')}
          htmlFor="githubCLIPath"
          stacked
          footer={!settings.githubCLIPath ? (
            <ToolDetectionDisplay
              info={toolsInfo?.gh || null}
              isLoading={isLoadingTools}
              t={t}
            />
          ) : undefined}
        >
          <Input
            id="githubCLIPath"
            placeholder={t('general.githubCLIPathPlaceholder')}
            className="h-9 w-full"
            value={settings.githubCLIPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, githubCLIPath: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('general.gitlabCLIPath')}
          description={t('general.gitlabCLIPathDescription')}
          htmlFor="gitlabCLIPath"
          stacked
          footer={!settings.gitlabCLIPath ? (
            <ToolDetectionDisplay
              info={toolsInfo?.glab || null}
              isLoading={isLoadingTools}
              t={t}
            />
          ) : undefined}
        >
          <Input
            id="gitlabCLIPath"
            placeholder={t('general.gitlabCLIPathPlaceholder')}
            className="h-9 w-full"
            value={settings.gitlabCLIPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, gitlabCLIPath: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('general.claudePath')}
          description={t('general.claudePathDescription')}
          htmlFor="claudePath"
          stacked
          footer={!settings.claudePath ? (
            <ToolDetectionDisplay
              info={toolsInfo?.claude || null}
              isLoading={isLoadingTools}
              t={t}
            />
          ) : undefined}
        >
          <Input
            id="claudePath"
            placeholder={t('general.claudePathPlaceholder')}
            className="h-9 w-full"
            value={settings.claudePath || ''}
            onChange={(e) => onSettingsChange({ ...settings, claudePath: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('general.autoClaudePath')}
          description={t('general.autoClaudePathDescription')}
          htmlFor="autoBuildPath"
          stacked
        >
          <Input
            id="autoBuildPath"
            placeholder={t('general.autoClaudePathPlaceholder')}
            className="h-9 w-full"
            value={settings.autoBuildPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, autoBuildPath: e.target.value })}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
