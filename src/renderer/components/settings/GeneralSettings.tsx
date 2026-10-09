import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Input } from '../ui/input';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { ProviderAgentTabs } from './ProviderAgentTabs';
import { DEFAULT_MAX_TERMINALS, MIN_TERMINALS, MAX_TERMINALS_LIMIT, DEFAULT_MAX_PARALLEL_TASKS, MIN_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT } from '../../../shared/constants';
import type {
  AppSettings,
  ToolDetectionResult
} from '../../../shared/types';

interface GeneralSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'agent' | 'terminal' | 'paths';
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
  const className = 'text-xs text-(--nav-label-color)';

  if (isLoading) {
    return <div className={className}>{t('general.detecting')}</div>;
  }

  if (!info || !info.found) {
    return <div className={className}>{t('general.notDetected')}</div>;
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

  // One muted line: "Auto-detected: /usr/bin/git · Version 2.43.0 · System PATH"
  return (
    <div className={`${className} truncate`} title={info.path}>
      {t('general.detectedPath')}: <span className="font-mono">{info.path}</span>
      {info.version && ` · ${t('general.detectedVersion')} ${info.version}`}
      {` · ${getSourceLabel(info.source)}`}
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
      // Provider-tabbed agent settings (profiles, features, model overrides)
      <ProviderAgentTabs />
    );
  }

  if (section === 'terminal') {
    return (
      <>
      <SettingsSection title={t('general.terminals')}>
        <SettingsRows>
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
      <SettingsSection title={t('settings:projectSections.queue.title')}>
        <SettingsRows>
          <SettingsRow
            label={t('settings:projectSections.queue.maxParallelTasks')}
            description={t('settings:projectSections.queue.maxParallelTasksDescription', {
              min: MIN_PARALLEL_TASKS,
              max: MAX_PARALLEL_TASKS_LIMIT
            })}
            htmlFor="maxParallelTasks"
          >
            <Input
              id="maxParallelTasks"
              type="number"
              min={MIN_PARALLEL_TASKS}
              max={MAX_PARALLEL_TASKS_LIMIT}
              className="w-20"
              value={settings.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (e.target.value === '' || !Number.isFinite(value)) return;
                const clamped = Math.min(MAX_PARALLEL_TASKS_LIMIT, Math.max(MIN_PARALLEL_TASKS, Math.round(value)));
                onSettingsChange({ ...settings, maxParallelTasks: clamped });
              }}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
      </>
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
            className="w-full"
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
            className="w-full"
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
            className="w-full"
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
            className="w-full"
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
            className="w-full"
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
            className="w-full"
            value={settings.autoBuildPath || ''}
            onChange={(e) => onSettingsChange({ ...settings, autoBuildPath: e.target.value })}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
