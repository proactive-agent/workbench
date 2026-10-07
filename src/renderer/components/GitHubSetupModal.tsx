import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Link, Loader2, Plus } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Label } from './ui/label';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { GitHubOAuthFlow } from './project-settings/GitHubOAuthFlow';
import { ProviderAccountsList } from './settings/ProviderAccountsList';
import { SegmentedControl, SettingsRow, SettingsRows } from './settings/SettingsRow';
import { useSettingsStore } from '../stores/settings-store';
import type { Project, ProjectSettings } from '../../shared/types';

interface GitHubSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onComplete: (settings: { githubToken: string; githubRepo: string; mainBranch: string; githubAuthMethod?: 'oauth' | 'pat' }) => void;
  onSkip?: () => void;
}

type SetupStep = 'github-auth' | 'claude-auth' | 'repo-confirm' | 'repo' | 'branch' | 'complete';

/**
 * Setup Modal - Required setup flow after Auto Claude initialization
 *
 * Flow:
 * 1. Authenticate with GitHub (via gh CLI OAuth) - for repo operations
 * 2. Authenticate with Claude (via claude CLI OAuth) - for AI features
 * 3. Detect/confirm repository
 * 4. Select base branch for tasks (with recommended default)
 */
export function GitHubSetupModal({
  open,
  onOpenChange,
  project,
  onComplete,
  onSkip
}: GitHubSetupModalProps) {
  const { t } = useTranslation('dialogs');
  const { getProviderAccounts, loadProviderAccounts } = useSettingsStore();
  const [step, setStep] = useState<SetupStep>('github-auth');
  const [githubToken, setGithubToken] = useState<string | null>(null);
  const [githubRepo, setGithubRepo] = useState<string | null>(null);
  const [detectedRepo, setDetectedRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [recommendedBranch, setRecommendedBranch] = useState<string | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isLoadingRepo, setIsLoadingRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repo setup state (for when no remote is detected)
  const [repoAction, setRepoAction] = useState<'create' | 'link' | null>(null);
  const [newRepoName, setNewRepoName] = useState('');
  const [isPrivateRepo, setIsPrivateRepo] = useState(true);
  const [existingRepoName, setExistingRepoName] = useState('');
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);

  // Organization selection state
  const [githubUsername, setGithubUsername] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<Array<{ login: string; avatarUrl?: string }>>([]);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);

  // Reset state and check existing auth when modal opens
  useEffect(() => {
    if (open) {
      // Reset all state first
      setGithubToken(null);
      setGithubRepo(null);
      setDetectedRepo(null);
      setBranches([]);
      setSelectedBranch(null);
      setRecommendedBranch(null);
      setError(null);
      // Reset repo setup state
      setRepoAction(null);
      setNewRepoName(project.name.replace(/[^A-Za-z0-9_.-]/g, '-'));
      setIsPrivateRepo(true);
      setExistingRepoName('');
      setIsCreatingRepo(false);
      // Reset organization state
      setGithubUsername(null);
      setOrganizations([]);
      setSelectedOwner(null);
      setIsLoadingOrgs(false);

      // Check for existing authentication and skip to appropriate step
      const checkExistingAuth = async () => {
        try {
          // Check for existing GitHub token
          const ghTokenResult = await window.electronAPI.getGitHubToken();
          const hasGitHubAuth = ghTokenResult.success && ghTokenResult.data?.token;

          // Check for existing AI provider accounts
          await loadProviderAccounts();
          const accounts = getProviderAccounts();
          const hasAIAuth = accounts.length > 0;

          // Determine starting step based on existing auth
          if (hasGitHubAuth && hasAIAuth) {
            // Both authenticated, go directly to repo detection
            setGithubToken(ghTokenResult.data!.token);
            setStep('repo'); // Temporary, detectRepository will update
            await detectRepository();
          } else if (hasGitHubAuth) {
            // Only GitHub authenticated, go to AI provider auth
            setGithubToken(ghTokenResult.data!.token);
            setStep('claude-auth');
          } else {
            // No auth, start from beginning
            setStep('github-auth');
          }
        } catch (err) {
          console.error('Failed to check existing auth:', err);
          // On error, start from beginning
          setStep('github-auth');
        }
      };

      checkExistingAuth();
    }
  }, [open]);

  // Load user info and organizations
  const loadUserAndOrgs = async () => {
    setIsLoadingOrgs(true);
    try {
      // Get current user
      const userResult = await window.electronAPI.getGitHubUser();
      if (userResult.success && userResult.data) {
        setGithubUsername(userResult.data.username);
        setSelectedOwner(userResult.data.username); // Default to personal account
      }

      // Get organizations
      const orgsResult = await window.electronAPI.listGitHubOrgs();
      if (orgsResult.success && orgsResult.data) {
        setOrganizations(orgsResult.data.orgs);
      }
    } catch (err) {
      console.error('Failed to load user/orgs:', err);
    } finally {
      setIsLoadingOrgs(false);
    }
  };

  // Detect repository from git remote when auth succeeds
  const detectRepository = async () => {
    setIsLoadingRepo(true);
    setError(null);

    try {
      // Try to detect repo from git remote
      const result = await window.electronAPI.detectGitHubRepo(project.path);
      if (result.success && result.data) {
        setDetectedRepo(result.data);
        setGithubRepo(result.data);
        // Go to confirmation step instead of directly to branch
        setStep('repo-confirm');
      } else {
        // No remote detected, load orgs and show repo setup step
        await loadUserAndOrgs();
        setStep('repo');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect repository');
      await loadUserAndOrgs();
      setStep('repo');
    } finally {
      setIsLoadingRepo(false);
    }
  };

  // Load branches from GitHub
  const loadBranches = async (repo: string) => {
    setIsLoadingBranches(true);
    setError(null);

    try {
      // Get branches from GitHub API
      const result = await window.electronAPI.getGitHubBranches(repo, githubToken!);
      if (result.success && result.data) {
        setBranches(result.data);

        // Detect recommended branch (main > master > develop > first)
        const recommended = detectRecommendedBranch(result.data);
        setRecommendedBranch(recommended);
        setSelectedBranch(recommended);
      } else {
        setError(result.error || 'Failed to load branches');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      setIsLoadingBranches(false);
    }
  };

  // Detect recommended branch from list
  const detectRecommendedBranch = (branchList: string[]): string | null => {
    const priorities = ['main', 'master', 'develop', 'dev'];
    for (const priority of priorities) {
      if (branchList.includes(priority)) {
        return priority;
      }
    }
    return branchList[0] || null;
  };

  // Handle GitHub OAuth success
  const handleGitHubAuthSuccess = async (token: string) => {
    setGithubToken(token);

    // Check if user already has AI provider accounts configured
    try {
      await loadProviderAccounts();
      const accounts = getProviderAccounts();
      if (accounts.length > 0) {
        // Already has provider accounts, skip AI auth and go directly to repo detection
        await detectRepository();
        return;
      }
    } catch (err) {
      console.error('Failed to check provider accounts:', err);
      // On error, fall through to show AI auth step
    }

    // No provider accounts, show AI auth step
    setStep('claude-auth');
  };

  // Handle AI provider auth continue — called when user has added at least one provider account
  const handleAIAuthContinue = async () => {
    await detectRepository();
  };

  // Handle creating a new GitHub repository
  const handleCreateRepo = async () => {
    if (!newRepoName.trim()) {
      setError(t('githubSetup.errors.repoNameRequired'));
      return;
    }

    if (!selectedOwner) {
      setError(t('githubSetup.errors.ownerRequired'));
      return;
    }

    setIsCreatingRepo(true);
    setError(null);

    try {
      const result = await window.electronAPI.createGitHubRepo(newRepoName.trim(), {
        isPrivate: isPrivateRepo,
        projectPath: project.path,
        owner: selectedOwner !== githubUsername ? selectedOwner : undefined // Only pass owner if it's an org
      });

      if (result.success && result.data) {
        // Repo created and remote added automatically by gh CLI
        setGithubRepo(result.data.fullName);
        setDetectedRepo(result.data.fullName);
        setStep('branch');
        await loadBranches(result.data.fullName);
      } else {
        setError(result.error || 'Failed to create repository');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create repository');
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // Handle confirming the detected repository
  const handleConfirmRepo = async () => {
    if (detectedRepo) {
      setStep('branch');
      await loadBranches(detectedRepo);
    }
  };

  // Handle changing the repository (go to repo setup)
  const handleChangeRepo = async () => {
    await loadUserAndOrgs();
    setStep('repo');
  };

  // Handle linking to an existing GitHub repository
  const handleLinkRepo = async () => {
    if (!existingRepoName.trim()) {
      setError(t('githubSetup.errors.repoPathRequired'));
      return;
    }

    // Validate format
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(existingRepoName.trim())) {
      setError(t('githubSetup.errors.invalidRepoFormat'));
      return;
    }

    setIsCreatingRepo(true);
    setError(null);

    try {
      const result = await window.electronAPI.addGitRemote(project.path, existingRepoName.trim());

      if (result.success) {
        setGithubRepo(existingRepoName.trim());
        setDetectedRepo(existingRepoName.trim());
        setStep('branch');
        await loadBranches(existingRepoName.trim());
      } else {
        setError(result.error || 'Failed to add remote');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add remote');
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // Handle branch selection complete
  const handleComplete = () => {
    if (githubToken && githubRepo && selectedBranch) {
      onComplete({
        githubToken,
        githubRepo,
        mainBranch: selectedBranch,
        githubAuthMethod: 'oauth' // Setup modal always uses OAuth flow
      });
    }
  };

  // Option row used for the create/link repository choice
  const renderRepoOption = (
    Icon: typeof Plus,
    title: string,
    description: string,
    ariaLabel: string,
    onClick: () => void
  ) => (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-nav-hover"
      aria-label={ariaLabel}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{title}</div>
        <div className="text-sm text-(--nav-label-color)">{description}</div>
      </div>
      <ChevronRight
        className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground"
        strokeWidth={1.75}
      />
    </button>
  );

  const renderBackLink = (label: string) => (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => setRepoAction(null)}
        className="text-foreground hover:underline"
        aria-label={t('githubSetup.goBackAriaLabel')}
      >
        {t('githubSetup.back')}
      </button>
      <span>{label}</span>
    </div>
  );

  const renderError = () =>
    error ? (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    ) : null;

  // Render step content
  const renderStepContent = () => {
    switch (step) {
      case 'github-auth':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.connectTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.connectDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="pt-4">
              <GitHubOAuthFlow
                onSuccess={handleGitHubAuthSuccess}
                onCancel={onSkip}
              />
            </div>
          </>
        );

      case 'claude-auth':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.aiProviderTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.aiProviderDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6 pt-4">
              <ProviderAccountsList />

              {getProviderAccounts().length > 0 && (
                <div className="flex items-center gap-2 rounded-xl bg-segment-track px-4 py-3 text-sm">
                  <Check className="h-4 w-4 text-success shrink-0" />
                  <p className="text-sm text-foreground">
                    {t('githubSetup.aiProviderReady')}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              {onSkip && (
                <Button variant="ghost" onClick={onSkip} size="sm">
                  {t('githubSetup.skipForNow')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleAIAuthContinue}
                disabled={getProviderAccounts().length === 0}
              >
                {t('githubSetup.continue')}
              </Button>
            </DialogFooter>
          </>
        );

      case 'repo-confirm':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.confirmRepoTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.confirmRepoDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="pt-4 space-y-4">
              <div className="flex items-center gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
                <Check className="h-4 w-4 text-success shrink-0" />
                <div className="min-w-0">
                  <p className="text-foreground">{t('githubSetup.repoDetected')}</p>
                  <p className="text-muted-foreground font-mono truncate">
                    {detectedRepo}
                  </p>
                </div>
              </div>

              <p className="text-sm text-muted-foreground">
                {t('githubSetup.repoDescription')}
              </p>

              {renderError()}
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={handleChangeRepo}>
                {t('githubSetup.useDifferentRepo')}
              </Button>
              <Button size="sm" onClick={handleConfirmRepo}>
                {t('githubSetup.confirmAndContinue')}
              </Button>
            </DialogFooter>
          </>
        );

      case 'repo':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.connectTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.repoNeededDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="pt-4 space-y-4">
              {/* Action selection */}
              {!repoAction && (
                <div className="-mx-3 space-y-1">
                  {renderRepoOption(
                    Plus,
                    t('githubSetup.createRepo'),
                    t('githubSetup.createRepoDescription'),
                    t('githubSetup.createRepoAriaLabel'),
                    () => setRepoAction('create')
                  )}
                  {renderRepoOption(
                    Link,
                    t('githubSetup.linkRepo'),
                    t('githubSetup.linkRepoDescription'),
                    t('githubSetup.linkRepoAriaLabel'),
                    () => setRepoAction('link')
                  )}
                </div>
              )}

              {/* Create new repo form */}
              {repoAction === 'create' && (
                <div className="space-y-4">
                  {renderBackLink(t('githubSetup.createRepoHeading'))}

                  <SettingsRows>
                    {/* Owner selection */}
                    <SettingsRow
                      label={t('githubSetup.owner')}
                      description={organizations.length > 0 ? t('githubSetup.ownerHint') : undefined}
                    >
                      {isLoadingOrgs ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {t('githubSetup.loadingAccounts')}
                        </div>
                      ) : (
                        <Select
                          value={selectedOwner ?? ''}
                          onValueChange={setSelectedOwner}
                          disabled={isCreatingRepo}
                        >
                          <SelectTrigger aria-label={t('common:accessibility.repositoryOwnerAriaLabel')}>
                            <SelectValue placeholder={t('githubSetup.selectOwner')} />
                          </SelectTrigger>
                          <SelectContent>
                            {githubUsername && (
                              <SelectItem value={githubUsername}>{githubUsername}</SelectItem>
                            )}
                            {organizations.map((org) => (
                              <SelectItem key={org.login} value={org.login}>
                                {org.login}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </SettingsRow>

                    <SettingsRow label={t('githubSetup.repoName')} htmlFor="repo-name" stacked>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                          {selectedOwner || '...'} /
                        </span>
                        <Input
                          id="repo-name"
                          value={newRepoName}
                          onChange={(e) => setNewRepoName(e.target.value)}
                          placeholder="my-project"
                          disabled={isCreatingRepo}
                          className="flex-1"
                        />
                      </div>
                    </SettingsRow>

                    <SettingsRow label={t('githubSetup.visibility')}>
                      <SegmentedControl
                        value={isPrivateRepo ? 'private' : 'public'}
                        onValueChange={(v) => {
                          if (!isCreatingRepo) setIsPrivateRepo(v === 'private');
                        }}
                        ariaLabel={t('common:accessibility.repositoryVisibilityAriaLabel')}
                        options={[
                          { value: 'private', label: t('githubSetup.private') },
                          { value: 'public', label: t('githubSetup.public') }
                        ]}
                      />
                    </SettingsRow>
                  </SettingsRows>
                </div>
              )}

              {/* Link existing repo form */}
              {repoAction === 'link' && (
                <div className="space-y-4">
                  {renderBackLink(t('githubSetup.linkRepoHeading'))}

                  <div className="space-y-2">
                    <Label htmlFor="existing-repo">{t('githubSetup.repository')}</Label>
                    <Input
                      id="existing-repo"
                      value={existingRepoName}
                      onChange={(e) => setExistingRepoName(e.target.value)}
                      placeholder="username/repository"
                      disabled={isCreatingRepo}
                    />
                    <p className="text-sm text-(--nav-label-color)">
                      {t('githubSetup.repositoryHint')}
                    </p>
                  </div>
                </div>
              )}

              {renderError()}
            </div>

            <DialogFooter>
              {onSkip && (
                <Button variant="ghost" size="sm" onClick={onSkip} disabled={isCreatingRepo}>
                  {t('githubSetup.skipForNow')}
                </Button>
              )}
              {repoAction === 'create' && (
                <Button size="sm" onClick={handleCreateRepo} disabled={isCreatingRepo || !newRepoName.trim()}>
                  {isCreatingRepo ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('githubSetup.creating')}
                    </>
                  ) : (
                    t('githubSetup.createRepository')
                  )}
                </Button>
              )}
              {repoAction === 'link' && (
                <Button size="sm" onClick={handleLinkRepo} disabled={isCreatingRepo || !existingRepoName.trim()}>
                  {isCreatingRepo ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('githubSetup.linking')}
                    </>
                  ) : (
                    t('githubSetup.linkRepository')
                  )}
                </Button>
              )}
              {!repoAction && (
                <Button variant="outline" size="sm" onClick={detectRepository} disabled={isLoadingRepo}>
                  {isLoadingRepo ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('githubSetup.checking')}
                    </>
                  ) : (
                    t('githubSetup.retryDetection')
                  )}
                </Button>
              )}
            </DialogFooter>
          </>
        );

      case 'branch':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.selectBranch')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.branchDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="pt-4 space-y-4">
              <SettingsRows>
                {/* Detected repo */}
                {detectedRepo && (
                  <SettingsRow label={t('githubSetup.repository')}>
                    <span className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground">
                      {detectedRepo}
                      <Check className="h-4 w-4 text-success" />
                    </span>
                  </SettingsRow>
                )}

                {/* Branch selector */}
                <SettingsRow
                  label={t('githubSetup.baseBranch')}
                  description={
                    selectedBranch
                      ? t('githubSetup.branchPatternWithBase', { branchName: selectedBranch })
                      : t('githubSetup.branchPattern')
                  }
                >
                  <Select
                    value={selectedBranch || ''}
                    onValueChange={setSelectedBranch}
                    disabled={isLoadingBranches || branches.length === 0}
                  >
                    <SelectTrigger aria-label={t('githubSetup.baseBranch')}>
                      {isLoadingBranches ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>{t('githubSetup.loadingBranches')}</span>
                        </div>
                      ) : (
                        <SelectValue placeholder={t('githubSetup.selectBranchPlaceholder')} />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((branch) => (
                        <SelectItem key={branch} value={branch}>
                          <div className="flex items-center gap-2">
                            <span>{branch}</span>
                            {branch === recommendedBranch && (
                              <span className="text-xs text-muted-foreground">
                                {t('githubSetup.recommended')}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              </SettingsRows>

              {/* Info about branch selection */}
              <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
                <p className="text-foreground">{t('githubSetup.whyBranch')}</p>
                <p className="mt-1 text-muted-foreground">
                  {t('githubSetup.branchExplanation')}
                </p>
              </div>

              {renderError()}
            </div>

            <DialogFooter>
              {onSkip && (
                <Button variant="ghost" size="sm" onClick={onSkip}>
                  {t('githubSetup.skipForNow')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleComplete}
                disabled={!selectedBranch || isLoadingBranches}
              >
                {t('githubSetup.completeSetup')}
              </Button>
            </DialogFooter>
          </>
        );

      case 'complete':
        return (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('githubSetup.setupComplete')}
              </DialogTitle>
            </DialogHeader>

            <div className="py-8 flex items-start justify-center gap-2">
              <Check className="h-4 w-4 mt-0.5 shrink-0 text-success" />
              <p className="text-sm text-muted-foreground">
                {t('githubSetup.ready', { branchName: selectedBranch ?? '' })}
              </p>
            </div>
          </>
        );
    }
  };

  // Progress indicator
  const renderProgress = () => {
    const steps: { label: string }[] = [
      { label: t('githubSetup.progressAuthenticate') },
      { label: t('githubSetup.progressConfigure') },
    ];

    // Don't show progress on complete step
    if (step === 'complete') return null;

    // Map steps to progress indices
    // Auth steps (github-auth, claude-auth, repo) = 0
    // Config steps (branch) = 1
    const currentIndex =
      step === 'github-auth' ? 0 :
      step === 'claude-auth' ? 0 :
      step === 'repo' ? 0 :
      1;

    return (
      <div className="flex items-center gap-2 mb-4 text-xs">
        {steps.map((s, index) => (
          <div key={index} className="flex items-center">
            {index < currentIndex && <Check className="mr-1 h-3.5 w-3.5 text-success" />}
            <span className={index === currentIndex ? 'text-foreground' : 'text-muted-foreground'}>
              {s.label}
            </span>
            {index < steps.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 mx-2 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={step === 'claude-auth' ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
        {renderProgress()}
        {renderStepContent()}
      </DialogContent>
    </Dialog>
  );
}
