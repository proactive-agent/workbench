import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { cn } from '../../lib/utils';
import { buildBranchOptions } from '../../lib/branch-utils';
import type { ProjectEnvConfig, ProjectSettings, GitBranchDetail } from '../../../shared/types';

interface BranchSettingsProps {
  projectPath: string;
  settings: ProjectSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettings>>;
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

/**
 * Project branch settings: the base branch for task and terminal worktrees, and whether new
 * task branches are pushed to origin by default.
 */
export function BranchSettings({ projectPath, settings, setSettings, envConfig, updateEnvConfig }: BranchSettingsProps) {
  const { t } = useTranslation('settings');
  const [branches, setBranches] = useState<GitBranchDetail[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  // Saved in project settings (used by the app) and the project .env (DEFAULT_BRANCH)
  const handleBranchChange = (branch: string) => {
    setSettings((prev) => ({ ...prev, mainBranch: branch }));
    updateEnvConfig({ defaultBranch: branch });
  };

  const fetchBranches = async () => {
    setIsLoadingBranches(true);
    setBranchesError(null);
    try {
      const result = await window.electronAPI.getGitBranchesWithInfo(projectPath);
      if (result.success && result.data) {
        setBranches(result.data);
        // No branch chosen yet: pick the repository's main branch
        if (!settings.mainBranch && !envConfig?.defaultBranch) {
          const detectResult = await window.electronAPI.detectMainBranch(projectPath);
          if (detectResult.success && detectResult.data) {
            handleBranchChange(detectResult.data);
          }
        }
      } else {
        setBranchesError(result.error || t('projectPages.general.branches.loadFailed'));
      }
    } catch (err) {
      setBranchesError(err instanceof Error ? err.message : t('projectPages.general.branches.loadFailed'));
    } finally {
      setIsLoadingBranches(false);
    }
  };

  // Load the branch list once per project
  useEffect(() => {
    void fetchBranches();
  }, [projectPath]);

  const branchOptions = useMemo(
    () =>
      buildBranchOptions(branches, {
        t,
        includeAutoDetect: { value: '', label: t('projectPages.general.branches.autoDetect') }
      }),
    [branches, t]
  );

  const selectedBranch = settings.mainBranch || envConfig?.defaultBranch || '';

  return (
    <SettingsSection title={t('projectPages.general.branches.title')}>
      <SettingsRows>
        <SettingsRow
          label={t('projectPages.general.branches.defaultBranch')}
          description={
            selectedBranch
              ? t('projectPages.general.branches.selectedBranchHelp', { branch: selectedBranch })
              : t('projectPages.general.branches.defaultBranchDescription')
          }
          footer={
            branchesError ? (
              <StatusIndicator state="error" tone="destructive">
                {branchesError}
              </StatusIndicator>
            ) : undefined
          }
        >
          <Combobox
            options={branchOptions}
            value={selectedBranch}
            onValueChange={handleBranchChange}
            placeholder={t('projectPages.general.branches.autoDetect')}
            searchPlaceholder={t('projectPages.general.branches.searchPlaceholder')}
            emptyMessage={t('projectPages.general.branches.noBranchesFound')}
            disabled={isLoadingBranches}
            className="field-border min-w-[14rem] justify-end"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchBranches}
            disabled={isLoadingBranches}
            className="h-8 w-8 text-muted-foreground"
            aria-label={t('projectPages.general.branches.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isLoadingBranches && 'animate-spin')} strokeWidth={1.75} />
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('projectPages.general.branches.pushNewBranches')}
          description={t('projectPages.general.branches.pushNewBranchesDescription')}
        >
          <Switch
            checked={settings.pushNewBranches !== false}
            onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, pushNewBranches: checked }))}
            aria-label={t('projectPages.general.branches.pushNewBranches')}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
