import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, KeyRound, Loader2, Lock, Globe, ChevronDown, GitBranch, Terminal, ExternalLink } from 'lucide-react';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { Button } from '../../ui/button';
import { SettingsSection } from '../SettingsSection';
import { SettingsRow, SettingsRows } from '../SettingsRow';
import { StatusIndicator } from '../common/StatusIndicator';
import { cn } from '../../../lib/utils';
import { PasswordInput } from '../../project-settings/PasswordInput';
import type { ProjectEnvConfig, GitLabSyncStatus, ProjectSettings } from '../../../../shared/types';

// Debug logging
const DEBUG = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';
function debugLog(message: string, data?: unknown) {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[GitLabIntegration] ${message}`, data);
    } else {
      console.warn(`[GitLabIntegration] ${message}`);
    }
  }
}

interface GitLabProject {
  pathWithNamespace: string;
  description: string | null;
  visibility: string;
}

interface GitLabIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showGitLabToken: boolean;
  setShowGitLabToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitLabConnectionStatus: GitLabSyncStatus | null;
  isCheckingGitLab: boolean;
  projectPath?: string;
  // Project settings for mainBranch (used by kanban tasks and terminal worktrees)
  settings?: ProjectSettings;
  setSettings?: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

/**
 * GitLab integration settings component.
 * Manages GitLab token (manual or OAuth), project configuration, and connection status.
 * Supports both GitLab.com and self-hosted instances.
 */
export function GitLabIntegration({
  envConfig,
  updateEnvConfig,
  showGitLabToken: _showGitLabToken,
  setShowGitLabToken: _setShowGitLabToken,
  gitLabConnectionStatus,
  isCheckingGitLab,
  projectPath,
  settings,
  setSettings
}: GitLabIntegrationProps) {
  const { t } = useTranslation(['gitlab', 'settings']);
  const [authMode, setAuthMode] = useState<'manual' | 'oauth' | 'oauth-success'>('manual');
  const [oauthUsername, setOauthUsername] = useState<string | null>(null);
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // Branch selection state
  const [branches, setBranches] = useState<string[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  // glab CLI detection state
  const [glabInstalled, setGlabInstalled] = useState<boolean | null>(null);
  const [glabVersion, setGlabVersion] = useState<string | null>(null);
  const [isCheckingGlab, setIsCheckingGlab] = useState(false);
  const [isInstallingGlab, setIsInstallingGlab] = useState(false);
  const [glabInstallSuccess, setGlabInstallSuccess] = useState(false);

  debugLog('Render - authMode:', authMode);
  debugLog('Render - projectPath:', projectPath);
  debugLog('Render - envConfig:', envConfig ? { gitlabEnabled: envConfig.gitlabEnabled, hasToken: !!envConfig.gitlabToken, defaultBranch: envConfig.defaultBranch } : null);

  // Fetch projects when entering oauth-success mode
  useEffect(() => {
    if (authMode === 'oauth-success') {
      fetchUserProjects();
    }
  }, [authMode]);

  // Check glab CLI on mount
  useEffect(() => {
    const checkGlab = async () => {
      setIsCheckingGlab(true);
      try {
        const result = await window.electronAPI.checkGitLabCli();
        debugLog('checkGitLabCli result:', result);
        if (result.success && result.data) {
          setGlabInstalled(result.data.installed);
          setGlabVersion(result.data.version || null);
        } else {
          setGlabInstalled(false);
        }
      } catch (error) {
        debugLog('Error checking glab CLI:', error);
        setGlabInstalled(false);
      } finally {
        setIsCheckingGlab(false);
      }
    };
    checkGlab();
  }, []);

  // Fetch branches when GitLab is enabled and project path is available
  useEffect(() => {
    debugLog(`useEffect[branches] - gitlabEnabled: ${envConfig?.gitlabEnabled}, projectPath: ${projectPath}`);
    if (envConfig?.gitlabEnabled && projectPath) {
      debugLog('useEffect[branches] - Triggering fetchBranches');
      fetchBranches();
    } else {
      debugLog('useEffect[branches] - Skipping fetchBranches (conditions not met)');
    }
  }, [envConfig?.gitlabEnabled, projectPath]);

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
      debugLog('fetchBranches: Calling getGitBranches...');
      const result = await window.electronAPI.getGitBranches(projectPath);
      debugLog('fetchBranches: getGitBranches result:', { success: result.success, dataType: typeof result.data, dataLength: Array.isArray(result.data) ? result.data.length : 'N/A', error: result.error });

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

  const fetchUserProjects = async () => {
    debugLog('Fetching user projects...');
    setIsLoadingProjects(true);
    setProjectsError(null);

    try {
      const hostname = envConfig?.gitlabInstanceUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const result = await window.electronAPI.listGitLabUserProjects(hostname);
      debugLog('listGitLabUserProjects result:', result);

      if (result.success && result.data?.projects) {
        setProjects(result.data.projects);
        debugLog('Loaded projects:', result.data.projects.length);
      } else {
        setProjectsError(result.error || 'Failed to load projects');
      }
    } catch (err) {
      debugLog('Error fetching projects:', err);
      setProjectsError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setIsLoadingProjects(false);
    }
  };

  if (!envConfig) {
    debugLog('No envConfig, returning null');
    return null;
  }

  const handleOAuthSuccess = async () => {
    debugLog('handleOAuthSuccess called');

    try {
      const hostname = envConfig?.gitlabInstanceUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const tokenResult = await window.electronAPI.getGitLabToken(hostname);
      if (tokenResult.success && tokenResult.data?.token) {
        updateEnvConfig({ gitlabToken: tokenResult.data.token });
      }

      const userResult = await window.electronAPI.getGitLabUser(hostname);
      if (userResult.success && userResult.data?.username) {
        setOauthUsername(userResult.data.username);
      }

      setAuthMode('oauth-success');
    } catch (err) {
      debugLog('Error in OAuth success:', err);
    }
  };

  const handleStartOAuth = async () => {
    const hostname = envConfig?.gitlabInstanceUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const result = await window.electronAPI.startGitLabAuth(hostname);

    if (result.success) {
      // Poll for auth completion
      const checkAuth = async () => {
        const authResult = await window.electronAPI.checkGitLabAuth(hostname);
        if (authResult.success && authResult.data?.authenticated) {
          handleOAuthSuccess();
        } else {
          // Retry after delay
          setTimeout(checkAuth, 2000);
        }
      };
      setTimeout(checkAuth, 3000);
    }
  };

  const handleSwitchToManual = () => {
    setAuthMode('manual');
    setOauthUsername(null);
  };

  const handleSwitchToOAuth = () => {
    setAuthMode('oauth');
    handleStartOAuth();
  };

  const handleSelectProject = (projectPath: string) => {
    debugLog('Selected project:', projectPath);
    updateEnvConfig({ gitlabProject: projectPath });
  };

  const handleInstallGlab = async () => {
    setIsInstallingGlab(true);
    setGlabInstallSuccess(false);
    try {
      const result = await window.electronAPI.installGitLabCli();
      debugLog('installGitLabCli result:', result);
      if (result.success) {
        setGlabInstallSuccess(true);
        // Re-check after 5 seconds to give user time to complete installation
        setTimeout(async () => {
          await handleRefreshGlab();
          setIsInstallingGlab(false);
        }, 5000);
      } else {
        setIsInstallingGlab(false);
      }
    } catch (error) {
      debugLog('Error installing glab:', error);
      setIsInstallingGlab(false);
    }
  };

  const handleRefreshGlab = async () => {
    setIsCheckingGlab(true);
    setGlabInstallSuccess(false);
    try {
      const result = await window.electronAPI.checkGitLabCli();
      debugLog('checkGitLabCli refresh result:', result);
      if (result.success && result.data) {
        setGlabInstalled(result.data.installed);
        setGlabVersion(result.data.version || null);
      } else {
        setGlabInstalled(false);
      }
    } catch (error) {
      debugLog('Error refreshing glab status:', error);
      setGlabInstalled(false);
    } finally {
      setIsCheckingGlab(false);
    }
  };

  const selectedBranch = settings?.mainBranch || envConfig.defaultBranch || '';
  const gitlabUrl = envConfig.gitlabInstanceUrl || 'https://gitlab.com';

  return (
    <>
      <SettingsSection title={t('settings:projectSections.gitlab.title')}>
        <SettingsRows>
          <SettingsRow label={t('settings.enableIssues')} description={t('settings.enableIssuesDescription')}>
            <Switch
              checked={envConfig.gitlabEnabled}
              onCheckedChange={(checked) => updateEnvConfig({ gitlabEnabled: checked })}
              aria-label={t('settings.enableIssues')}
            />
          </SettingsRow>
          {envConfig.gitlabEnabled && (
            <SettingsRow label={t('settings.autoSyncOnLoad')} description={t('settings.autoSyncDescription')}>
              <Switch
                checked={envConfig.gitlabAutoSync || false}
                onCheckedChange={(checked) => updateEnvConfig({ gitlabAutoSync: checked })}
                aria-label={t('settings.autoSyncOnLoad')}
              />
            </SettingsRow>
          )}
        </SettingsRows>
      </SettingsSection>

      {envConfig.gitlabEnabled && (
        <>
          <SettingsSection title={t('settings.connectionTitle')}>
            <SettingsRows>
              {/* Instance URL */}
              <SettingsRow stacked label={t('settings.instance')} description={t('settings.instanceDescription')}>
                <Input
                  placeholder="https://gitlab.com"
                  value={gitlabUrl}
                  onChange={(e) => updateEnvConfig({ gitlabInstanceUrl: e.target.value })}
                />
              </SettingsRow>

              {/* OAuth Success State */}
              {authMode === 'oauth-success' && (
                <>
                  <SettingsRow
                    label={
                      <StatusIndicator state="success" tone="foreground">
                        {t('settings.connectedVia')}
                      </StatusIndicator>
                    }
                    description={oauthUsername ? `${t('settings.authenticatedAs')} ${oauthUsername}` : undefined}
                  >
                    <Button variant="outline" size="sm" onClick={handleSwitchToManual}>
                      {t('settings.useDifferentToken')}
                    </Button>
                  </SettingsRow>

                  <ProjectDropdown
                    projects={projects}
                    selectedProject={envConfig.gitlabProject || ''}
                    isLoading={isLoadingProjects}
                    error={projectsError}
                    onSelect={handleSelectProject}
                    onRefresh={fetchUserProjects}
                    onManualEntry={() => setAuthMode('manual')}
                  />
                </>
              )}

              {/* OAuth Flow */}
              {authMode === 'oauth' && (
                <SettingsRow
                  label={
                    <StatusIndicator state="loading" tone="foreground">
                      {t('settings.authenticating')}
                    </StatusIndicator>
                  }
                  description={t('settings.browserWindow')}
                >
                  <Button variant="outline" size="sm" onClick={handleSwitchToManual}>
                    {t('settings.useManualToken')}
                  </Button>
                </SettingsRow>
              )}

              {/* Manual Token Entry */}
              {authMode === 'manual' && (
                <>
                  {/* glab CLI status */}
                  {glabInstalled === false && (
                    <SettingsRow
                      label={t('settings.cli.required')}
                      description={
                        glabInstallSuccess ? (
                          t('settings.cli.installSuccess')
                        ) : (
                          <>
                            {t('settings.cli.notInstalled')}{' '}
                            <a
                              href="https://gitlab.com/gitlab-org/cli#installation"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                            >
                              {t('settings.cli.learnMore')}
                              <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                            </a>
                          </>
                        )
                      }
                    >
                      {glabInstallSuccess ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleRefreshGlab}
                          disabled={isCheckingGlab}
                          className="gap-2"
                        >
                          <RefreshCw className={cn('h-4 w-4', isCheckingGlab && 'animate-spin')} strokeWidth={1.75} />
                          {t('settings.cli.refresh')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleInstallGlab}
                          disabled={isInstallingGlab}
                          className="gap-2"
                        >
                          {isInstallingGlab ? (
                            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <Terminal className="h-4 w-4" strokeWidth={1.75} />
                          )}
                          {isInstallingGlab ? t('settings.cli.installing') : t('settings.cli.installButton')}
                        </Button>
                      )}
                    </SettingsRow>
                  )}

                  <SettingsRow
                    label={t('settings.oauth')}
                    description={
                      glabInstalled === true && glabVersion ? (
                        <StatusIndicator state="success">
                          {t('settings.cli.installed')} <span className="font-mono">{glabVersion}</span>
                        </StatusIndicator>
                      ) : (
                        t('settings.oauthDescription')
                      )
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSwitchToOAuth}
                      disabled={glabInstalled === false || isCheckingGlab}
                      className="gap-2"
                    >
                      {isCheckingGlab ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                      ) : (
                        <KeyRound className="h-4 w-4" strokeWidth={1.75} />
                      )}
                      {t('settings.useOAuth')}
                    </Button>
                  </SettingsRow>

                  <SettingsRow
                    stacked
                    label={t('settings.personalAccessToken')}
                    description={
                      <>
                        {t('settings.tokenScope')} <code className="font-mono">{t('settings.scopeApi')}</code>{' '}
                        {t('settings.scopeFrom')}{' '}
                        <a
                          href={`${gitlabUrl}/-/user_settings/personal_access_tokens`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {t('settings.gitlabSettings')}
                        </a>
                      </>
                    }
                  >
                    <PasswordInput
                      value={envConfig.gitlabToken || ''}
                      onChange={(value) => updateEnvConfig({ gitlabToken: value })}
                      placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                    />
                  </SettingsRow>

                  <SettingsRow
                    stacked
                    label={t('settings.project')}
                    description={
                      <>
                        {t('settings.projectFormat')} <code className="font-mono">group/project</code>{' '}
                        {t('settings.projectFormatExample')}
                      </>
                    }
                  >
                    <Input
                      placeholder="group/project"
                      value={envConfig.gitlabProject || ''}
                      onChange={(e) => updateEnvConfig({ gitlabProject: e.target.value })}
                    />
                  </SettingsRow>
                </>
              )}

              {envConfig.gitlabToken && envConfig.gitlabProject && (
                <SettingsRow
                  label={t('settings.connectionStatus')}
                  description={
                    gitLabConnectionStatus?.connected
                      ? gitLabConnectionStatus.projectDescription || t('settings.issuesAvailableDescription')
                      : undefined
                  }
                >
                  <StatusIndicator
                    state={isCheckingGitLab ? 'loading' : gitLabConnectionStatus?.connected ? 'success' : 'error'}
                    className="max-w-[20rem]"
                  >
                    <span className="truncate">
                      {isCheckingGitLab
                        ? t('settings.checking')
                        : gitLabConnectionStatus?.connected
                          ? `${t('settings.connectedTo')} ${gitLabConnectionStatus.projectPathWithNamespace}`
                          : gitLabConnectionStatus?.error || t('settings.notConnected')}
                    </span>
                  </StatusIndicator>
                </SettingsRow>
              )}
            </SettingsRows>
          </SettingsSection>

          {/* Default Branch Selector */}
          {projectPath && (
            <SettingsSection title={t('settings.branchesTitle')}>
              <SettingsRows>
                <BranchSelector
                  branches={branches}
                  selectedBranch={selectedBranch}
                  isLoading={isLoadingBranches}
                  error={branchesError}
                  onSelect={handleBranchChange}
                  onRefresh={fetchBranches}
                />
              </SettingsRows>
            </SettingsSection>
          )}
        </>
      )}
    </>
  );
}

interface ProjectDropdownProps {
  projects: GitLabProject[];
  selectedProject: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (projectPath: string) => void;
  onRefresh: () => void;
  onManualEntry: () => void;
}

function ProjectDropdown({
  projects,
  selectedProject,
  isLoading,
  error,
  onSelect,
  onRefresh,
  onManualEntry
}: ProjectDropdownProps) {
  const { t } = useTranslation('gitlab');
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredProjects = projects.filter(project =>
    project.pathWithNamespace.toLowerCase().includes(filter.toLowerCase()) ||
    (project.description?.toLowerCase().includes(filter.toLowerCase()))
  );

  const selectedProjectData = projects.find(p => p.pathWithNamespace === selectedProject);

  return (
    <SettingsRow
      stacked
      label={
        <div className="flex items-center justify-between gap-2">
          <span>{t('settings.project')}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              disabled={isLoading}
              className="h-8 w-8 text-muted-foreground"
              aria-label={t('settings.cli.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} strokeWidth={1.75} />
            </Button>
            <Button variant="outline" size="sm" onClick={onManualEntry}>
              {t('settings.enterManually')}
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
              {t('settings.loadingProjects')}
            </span>
          ) : selectedProject ? (
            <span className="flex items-center gap-2">
              {selectedProjectData?.visibility === 'private' ? (
                <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              ) : (
                <Globe className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              )}
              {selectedProject}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('settings.selectProject')}</span>
          )}
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
        </button>

        {isOpen && !isLoading && (
          <div className="absolute z-50 mt-1 max-h-64 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            <div className="border-b border-border p-2">
              <Input
                placeholder={t('settings.searchProjects')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            </div>

            <div className="max-h-48 overflow-y-auto p-1">
              {filteredProjects.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {filter ? t('settings.noMatchingProjects') : t('settings.noProjectsFound')}
                </div>
              ) : (
                filteredProjects.map((project) => (
                  <button
                    key={project.pathWithNamespace}
                    type="button"
                    onClick={() => {
                      onSelect(project.pathWithNamespace);
                      setIsOpen(false);
                      setFilter('');
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-nav-hover',
                      project.pathWithNamespace === selectedProject && 'bg-nav-active'
                    )}
                  >
                    {project.visibility === 'private' ? (
                      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    ) : (
                      <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{project.pathWithNamespace}</p>
                      {project.description && (
                        <p className="truncate text-xs text-muted-foreground">{project.description}</p>
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

interface BranchSelectorProps {
  branches: string[];
  selectedBranch: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (branch: string) => void;
  onRefresh: () => void;
}

function BranchSelector({
  branches,
  selectedBranch,
  isLoading,
  error,
  onSelect,
  onRefresh
}: BranchSelectorProps) {
  const { t } = useTranslation('gitlab');
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredBranches = branches.filter(branch =>
    branch.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <SettingsRow
      label={t('settings.defaultBranch')}
      description={
        selectedBranch ? (
          <>
            {t('settings.branchFromNote')} <code className="font-mono">{selectedBranch}</code>
          </>
        ) : (
          t('settings.defaultBranchDescription')
        )
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
          aria-expanded={isOpen}
          className={cn(
            'flex h-8 max-w-[16rem] items-center gap-1.5 rounded-lg px-2 text-sm text-foreground outline-none',
            'hover:bg-nav-hover focus-visible:shadow-(--shadow-focus) disabled:opacity-50',
            isOpen && 'bg-nav-hover'
          )}
        >
          {isLoading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
              {t('settings.loadingBranches')}
            </span>
          ) : (
            <span className="truncate">{selectedBranch || t('settings.autoDetect')}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {isOpen && !isLoading && (
          <div className="absolute right-0 z-50 mt-1 max-h-64 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            <div className="border-b border-border p-2">
              <Input
                placeholder={t('settings.searchBranches')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            </div>

            <div className="max-h-48 overflow-y-auto p-1">
              <button
                type="button"
                onClick={() => {
                  onSelect('');
                  setIsOpen(false);
                  setFilter('');
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-nav-hover',
                  !selectedBranch && 'bg-nav-active'
                )}
              >
                {t('settings.autoDetect')}
              </button>
              {filteredBranches.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {filter ? t('settings.noMatchingBranches') : t('settings.noBranchesFound')}
                </div>
              ) : (
                filteredBranches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => {
                      onSelect(branch);
                      setIsOpen(false);
                      setFilter('');
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-nav-hover',
                      branch === selectedBranch && 'bg-nav-active'
                    )}
                  >
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="truncate text-sm text-foreground">{branch}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRefresh}
        disabled={isLoading}
        className="h-8 w-8 text-muted-foreground"
        aria-label={t('settings.refreshBranches')}
      >
        <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} strokeWidth={1.75} />
      </Button>
    </SettingsRow>
  );
}
