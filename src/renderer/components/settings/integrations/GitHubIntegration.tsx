import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, KeyRound, Loader2, Lock, Globe, ChevronDown } from 'lucide-react';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { Button } from '../../ui/button';
import { SettingsSection } from '../SettingsSection';
import { SettingsRow, SettingsRows } from '../SettingsRow';
import { StatusIndicator } from '../common/StatusIndicator';
import { cn } from '../../../lib/utils';
import { Combobox } from '../../ui/combobox';
import { GitHubOAuthFlow } from '../../project-settings/GitHubOAuthFlow';
import { PasswordInput } from '../../project-settings/PasswordInput';
import { buildBranchOptions } from '../../../lib/branch-utils';
import type { ProjectEnvConfig, GitHubSyncStatus, ProjectSettings, GitBranchDetail } from '../../../../shared/types';

// Debug logging
const DEBUG = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';
function debugLog(message: string, data?: unknown) {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[GitHubIntegration] ${message}`, data);
    } else {
      console.warn(`[GitHubIntegration] ${message}`);
    }
  }
}

interface GitHubRepo {
  fullName: string;
  description: string | null;
  isPrivate: boolean;
}

interface GitHubIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showGitHubToken: boolean;
  setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitHubConnectionStatus: GitHubSyncStatus | null;
  isCheckingGitHub: boolean;
  projectPath?: string; // Project path for fetching git branches
  // Project settings for mainBranch (used by kanban tasks and terminal worktrees)
  settings?: ProjectSettings;
  setSettings?: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

/**
 * GitHub integration settings component.
 * Manages GitHub token (manual or OAuth), repository configuration, and connection status.
 */
export function GitHubIntegration({
  envConfig,
  updateEnvConfig,
  showGitHubToken: _showGitHubToken,
  setShowGitHubToken: _setShowGitHubToken,
  gitHubConnectionStatus,
  isCheckingGitHub,
  projectPath,
  settings,
  setSettings
}: GitHubIntegrationProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [authMode, setAuthMode] = useState<'manual' | 'oauth' | 'oauth-success'>('manual');
  const [oauthUsername, setOauthUsername] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  // Branch selection state - now uses GitBranchDetail for local/remote distinction
  const [branches, setBranches] = useState<GitBranchDetail[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  debugLog('Render - authMode:', authMode);
  debugLog('Render - projectPath:', projectPath);
  debugLog('Render - envConfig:', envConfig ? { githubEnabled: envConfig.githubEnabled, hasToken: !!envConfig.githubToken, defaultBranch: envConfig.defaultBranch } : null);

  // Fetch repos when entering oauth-success mode
  useEffect(() => {
    if (authMode === 'oauth-success') {
      fetchUserRepos();
    }
  }, [authMode]);

  // Fetch branches when GitHub is enabled and project path is available
  useEffect(() => {
    debugLog(`useEffect[branches] - githubEnabled: ${envConfig?.githubEnabled}, projectPath: ${projectPath}`);
    if (envConfig?.githubEnabled && projectPath) {
      debugLog('useEffect[branches] - Triggering fetchBranches');
      fetchBranches();
    } else {
      debugLog('useEffect[branches] - Skipping fetchBranches (conditions not met)');
    }
  }, [envConfig?.githubEnabled, projectPath]);

  /**
   * Handler for branch selection changes.
   * Updates BOTH project.settings.mainBranch (for Electron app) and envConfig.defaultBranch (for CLI backward compatibility).
   */
  const handleBranchChange = (branch: string) => {
    debugLog('handleBranchChange: Updating branch to:', branch);

    // Update project settings (primary source for Electron app)
    if (setSettings) {
      setSettings(prev => ({ ...prev, mainBranch: branch }));
      debugLog('handleBranchChange: Updated settings.mainBranch');
    }

    // Also update envConfig for CLI backward compatibility
    updateEnvConfig({ defaultBranch: branch });
    debugLog('handleBranchChange: Updated envConfig.defaultBranch');
  };

  const fetchBranches = async () => {
    if (!projectPath) {
      debugLog('fetchBranches: No projectPath, skipping');
      return;
    }

    debugLog('fetchBranches: Starting with projectPath:', projectPath);
    setIsLoadingBranches(true);
    setBranchesError(null);

    try {
      debugLog('fetchBranches: Calling getGitBranchesWithInfo...');
      const result = await window.electronAPI.getGitBranchesWithInfo(projectPath);
      debugLog('fetchBranches: getGitBranchesWithInfo result:', { success: result.success, dataType: typeof result.data, dataLength: Array.isArray(result.data) ? result.data.length : 'N/A', error: result.error });

      // result.data is the GitBranchDetail[] array
      if (result.success && result.data) {
        setBranches(result.data);
        debugLog('fetchBranches: Loaded branches:', result.data.length);

        // Auto-detect default branch if not set in project settings
        // Priority: settings.mainBranch > envConfig.defaultBranch > auto-detect
        if (!settings?.mainBranch && !envConfig?.defaultBranch) {
          debugLog('fetchBranches: No branch set, auto-detecting...');
          const detectResult = await window.electronAPI.detectMainBranch(projectPath);
          debugLog('fetchBranches: detectMainBranch result:', detectResult);
          if (detectResult.success && detectResult.data) {
            debugLog('fetchBranches: Auto-detected default branch:', detectResult.data);
            handleBranchChange(detectResult.data);
          }
        }
      } else {
        debugLog('fetchBranches: Failed -', result.error || 'No data returned');
        setBranchesError(result.error || 'Failed to load branches');
      }
    } catch (err) {
      debugLog('fetchBranches: Exception:', err);
      setBranchesError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      setIsLoadingBranches(false);
    }
  };

  const fetchUserRepos = async () => {
    debugLog('Fetching user repositories...');
    setIsLoadingRepos(true);
    setReposError(null);

    try {
      const result = await window.electronAPI.listGitHubUserRepos();
      debugLog('listGitHubUserRepos result:', result);

      if (result.success && result.data?.repos) {
        setRepos(result.data.repos);
        debugLog('Loaded repos:', result.data.repos.length);
      } else {
        setReposError(result.error || 'Failed to load repositories');
      }
    } catch (err) {
      debugLog('Error fetching repos:', err);
      setReposError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setIsLoadingRepos(false);
    }
  };

  // Build branch options for Combobox using shared utility
  // Must be called before early return to satisfy React hooks rules
  const branchOptions = useMemo(() => {
    return buildBranchOptions(branches, {
      t,
      includeAutoDetect: {
        value: '',
        label: t('settings:projectSections.github.defaultBranch.autoDetect'),
      },
    });
  }, [branches, t]);

  if (!envConfig) {
    debugLog('No envConfig, returning null');
    return null;
  }

  const handleOAuthSuccess = (token: string, username?: string) => {
    debugLog('handleOAuthSuccess called with token length:', token.length);
    debugLog('OAuth username:', username);

    // Update the token and auth method
    updateEnvConfig({ githubToken: token, githubAuthMethod: 'oauth' });

    // Show success state with username
    setOauthUsername(username || null);
    setAuthMode('oauth-success');
  };

  const handleSwitchToManual = () => {
    setAuthMode('manual');
    setOauthUsername(null);
  };

  const handleSwitchToOAuth = () => {
    setAuthMode('oauth');
  };

  const handleSelectRepo = (repoFullName: string) => {
    debugLog('Selected repo:', repoFullName);
    updateEnvConfig({ githubRepo: repoFullName });
  };

  // Selected branch for Combobox value
  const selectedBranch = settings?.mainBranch || envConfig?.defaultBranch || '';
  const pushNewBranches = settings?.pushNewBranches !== false;

  const connectionRequested = !!(envConfig.githubToken && envConfig.githubRepo);

  return (
    <>
      <SettingsSection title={t('settings:projectSections.github.title')}>
        <SettingsRows>
          <SettingsRow
            label={t('settings:projectPages.github.enableIssues')}
            description={t('settings:projectPages.github.enableIssuesDescription')}
          >
            <Switch
              checked={envConfig.githubEnabled}
              onCheckedChange={(checked) => updateEnvConfig({ githubEnabled: checked })}
              aria-label={t('settings:projectPages.github.enableIssues')}
            />
          </SettingsRow>
          {envConfig.githubEnabled && (
            <SettingsRow
              label={t('settings:projectPages.github.autoSync')}
              description={t('settings:projectPages.github.autoSyncDescription')}
            >
              <Switch
                checked={envConfig.githubAutoSync || false}
                onCheckedChange={(checked) => updateEnvConfig({ githubAutoSync: checked })}
                aria-label={t('settings:projectPages.github.autoSync')}
              />
            </SettingsRow>
          )}
        </SettingsRows>
      </SettingsSection>

      {envConfig.githubEnabled && (
        <>
          <SettingsSection title={t('settings:projectPages.github.connectionTitle')}>
            <SettingsRows>
              {/* OAuth Success State */}
              {authMode === 'oauth-success' && (
                <>
                  <SettingsRow
                    label={
                      <StatusIndicator state="success" tone="foreground">
                        {t('settings:projectPages.github.connectedViaCli')}
                      </StatusIndicator>
                    }
                    description={
                      oauthUsername
                        ? t('settings:projectPages.github.authenticatedAs', { username: oauthUsername })
                        : undefined
                    }
                  >
                    <Button variant="outline" size="sm" onClick={handleSwitchToManual}>
                      {t('settings:projectPages.github.useDifferentToken')}
                    </Button>
                  </SettingsRow>

                  <RepositoryDropdown
                    repos={repos}
                    selectedRepo={envConfig.githubRepo || ''}
                    isLoading={isLoadingRepos}
                    error={reposError}
                    onSelect={handleSelectRepo}
                    onRefresh={fetchUserRepos}
                    onManualEntry={() => setAuthMode('manual')}
                  />
                </>
              )}

              {/* OAuth Flow */}
              {authMode === 'oauth' && (
                <SettingsRow
                  label={t('settings:projectPages.github.authentication')}
                  footer={<GitHubOAuthFlow onSuccess={handleOAuthSuccess} onCancel={handleSwitchToManual} />}
                >
                  <Button variant="outline" size="sm" onClick={handleSwitchToManual}>
                    {t('settings:projectPages.github.useManualToken')}
                  </Button>
                </SettingsRow>
              )}

              {/* Manual Token Entry */}
              {authMode === 'manual' && (
                <>
                  <SettingsRow
                    label={t('settings:projectPages.github.oauth')}
                    description={t('settings:projectPages.github.oauthDescription')}
                  >
                    <Button variant="outline" size="sm" onClick={handleSwitchToOAuth} className="gap-2">
                      <KeyRound className="h-4 w-4" strokeWidth={1.75} />
                      {t('settings:projectPages.github.useOAuth')}
                    </Button>
                  </SettingsRow>
                  <SettingsRow
                    stacked
                    label={t('settings:projectPages.github.token')}
                    description={
                      <>
                        {t('settings:projectPages.github.tokenDescription')}{' '}
                        <a
                          href="https://github.com/settings/tokens/new?scopes=repo&description=Auto-Build-UI"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {t('settings:projectPages.github.tokenLink')}
                        </a>
                      </>
                    }
                  >
                    <PasswordInput
                      value={envConfig.githubToken || ''}
                      onChange={(value) => updateEnvConfig({ githubToken: value })}
                      placeholder="ghp_xxxxxxxx or github_pat_xxxxxxxx"
                    />
                  </SettingsRow>
                  <SettingsRow
                    stacked
                    label={t('settings:projectPages.github.repository')}
                    description={t('settings:projectPages.github.repositoryFormat')}
                  >
                    <Input
                      placeholder="owner/repository"
                      value={envConfig.githubRepo || ''}
                      onChange={(e) => updateEnvConfig({ githubRepo: e.target.value })}
                    />
                  </SettingsRow>
                </>
              )}

              {connectionRequested && (
                <SettingsRow
                  label={t('settings:projectPages.github.connectionStatus')}
                  description={
                    gitHubConnectionStatus?.connected && gitHubConnectionStatus.repoDescription
                      ? gitHubConnectionStatus.repoDescription
                      : undefined
                  }
                >
                  <StatusIndicator
                    state={isCheckingGitHub ? 'loading' : gitHubConnectionStatus?.connected ? 'success' : 'error'}
                    className="max-w-[20rem]"
                  >
                    <span className="truncate">
                      {isCheckingGitHub
                        ? t('settings:projectPages.github.checking')
                        : gitHubConnectionStatus?.connected
                          ? t('settings:projectPages.github.connectedTo', { repo: gitHubConnectionStatus.repoFullName })
                          : gitHubConnectionStatus?.error || t('settings:projectPages.github.notConnected')}
                    </span>
                  </StatusIndicator>
                </SettingsRow>
              )}
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('settings:projectPages.github.branchesTitle')}>
            <SettingsRows>
              {/* Default Branch Selector */}
              {projectPath && (
                <SettingsRow
                  label={t('settings:projectSections.github.defaultBranch.label')}
                  description={
                    selectedBranch
                      ? t('settings:projectSections.github.defaultBranch.selectedBranchHelp', { branch: selectedBranch })
                      : t('settings:projectSections.github.defaultBranch.description')
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
                    placeholder={t('settings:projectSections.github.defaultBranch.autoDetect')}
                    searchPlaceholder={t('settings:projectSections.github.defaultBranch.searchPlaceholder')}
                    emptyMessage={t('settings:projectSections.github.defaultBranch.noBranchesFound')}
                    disabled={isLoadingBranches}
                    className="field-border min-w-[14rem] justify-end"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={fetchBranches}
                    disabled={isLoadingBranches}
                    className="h-8 w-8 text-muted-foreground"
                    aria-label={t('settings:projectPages.github.refreshBranches')}
                  >
                    <RefreshCw className={cn('h-4 w-4', isLoadingBranches && 'animate-spin')} strokeWidth={1.75} />
                  </Button>
                </SettingsRow>
              )}

              {setSettings && (
                <SettingsRow
                  label={t('settings:projectSections.github.pushNewBranches.label')}
                  description={t('settings:projectSections.github.pushNewBranches.description')}
                >
                  <Switch
                    checked={pushNewBranches}
                    onCheckedChange={(checked) => setSettings(prev => ({ ...prev, pushNewBranches: checked }))}
                    aria-label={t('settings:projectSections.github.pushNewBranches.label')}
                  />
                </SettingsRow>
              )}
            </SettingsRows>
          </SettingsSection>
        </>
      )}
    </>
  );
}

interface RepositoryDropdownProps {
  repos: GitHubRepo[];
  selectedRepo: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (repoFullName: string) => void;
  onRefresh: () => void;
  onManualEntry: () => void;
}

function RepositoryDropdown({
  repos,
  selectedRepo,
  isLoading,
  error,
  onSelect,
  onRefresh,
  onManualEntry
}: RepositoryDropdownProps) {
  const { t } = useTranslation('settings');
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredRepos = repos.filter(repo =>
    repo.fullName.toLowerCase().includes(filter.toLowerCase()) ||
    (repo.description?.toLowerCase().includes(filter.toLowerCase()))
  );

  const selectedRepoData = repos.find(r => r.fullName === selectedRepo);

  return (
    <SettingsRow
      stacked
      label={
        <div className="flex items-center justify-between gap-2">
          <span>{t('projectPages.github.repository')}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              disabled={isLoading}
              className="h-8 w-8 text-muted-foreground"
              aria-label={t('projectPages.github.refreshRepositories')}
            >
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} strokeWidth={1.75} />
            </Button>
            <Button variant="outline" size="sm" onClick={onManualEntry}>
              {t('projectPages.github.enterManually')}
            </Button>
          </div>
        </div>
      }
      footer={
        error ? (
          <StatusIndicator state="error" tone="destructive">
            {error}
          </StatusIndicator>
        ) : undefined
      }
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          disabled={isLoading}
          className="field-border flex h-8 w-full items-center justify-between rounded-lg px-3 text-sm text-foreground outline-none disabled:opacity-50"
        >
          {isLoading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
              {t('projectPages.github.loadingRepositories')}
            </span>
          ) : selectedRepo ? (
            <span className="flex items-center gap-2">
              {selectedRepoData?.isPrivate ? (
                <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              ) : (
                <Globe className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              )}
              {selectedRepo}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('projectPages.github.selectRepository')}</span>
          )}
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
        </button>

        {isOpen && !isLoading && (
          <div className="absolute z-50 mt-1 max-h-64 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            {/* Search filter */}
            <div className="border-b border-border p-2">
              <Input
                placeholder={t('projectPages.github.searchRepositories')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            </div>

            {/* Repository list */}
            <div className="max-h-48 overflow-y-auto p-1">
              {filteredRepos.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {filter ? t('projectPages.github.noMatchingRepositories') : t('projectPages.github.noRepositories')}
                </div>
              ) : (
                filteredRepos.map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    onClick={() => {
                      onSelect(repo.fullName);
                      setIsOpen(false);
                      setFilter('');
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-nav-hover',
                      repo.fullName === selectedRepo && 'bg-nav-active'
                    )}
                  >
                    {repo.isPrivate ? (
                      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    ) : (
                      <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{repo.fullName}</p>
                      {repo.description && (
                        <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
