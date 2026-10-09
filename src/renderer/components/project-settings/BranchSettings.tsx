import { useEffect, useMemo } from 'react';
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
import { useProjectBranches } from '../../hooks/useProjectBranches';
import type { ProjectEnvConfig, ProjectSettings } from '../../../shared/types';

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
  // Shared, saved branch list: shown right away; Refresh fetches remote refs and lists again
  const { branches, detectedBranch, isLoading: isLoadingBranches, error, refresh } = useProjectBranches(projectPath);
  const branchesError = error === null ? null : error || t('projectPages.general.branches.loadFailed');

  // Saved in project settings (used by the app) and the project .env (DEFAULT_BRANCH)
  const handleBranchChange = (branch: string) => {
    setSettings((prev) => ({ ...prev, mainBranch: branch }));
    updateEnvConfig({ defaultBranch: branch });
  };

  // No branch chosen yet: pick the repository's default branch once it is known
  useEffect(() => {
    if (detectedBranch && !settings.mainBranch && !envConfig?.defaultBranch) {
      handleBranchChange(detectedBranch);
    }
  }, [detectedBranch]);

  const fetchBranches = () => {
    void refresh();
  };

  const branchOptions = useMemo(
    () =>
      buildBranchOptions(branches, {
        t,
        // Same wording as the task dialogs: "Project default (<branch>)"
        includeProjectDefault: {
          value: '',
          branchName: detectedBranch,
          labelKey: detectedBranch ? 'tasks:wizard.gitOptions.useProjectDefaultWithBranch' : 'projectPages.general.branches.autoDetect',
        },
      }),
    [branches, detectedBranch, t]
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
            placeholder={
              detectedBranch
                ? t('tasks:wizard.gitOptions.useProjectDefaultWithBranch', { branch: detectedBranch })
                : t('projectPages.general.branches.autoDetect')
            }
            searchPlaceholder={t('projectPages.general.branches.searchPlaceholder')}
            emptyMessage={t('projectPages.general.branches.noBranchesFound')}
            disabled={isLoadingBranches}
            className="field-border h-8"
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
