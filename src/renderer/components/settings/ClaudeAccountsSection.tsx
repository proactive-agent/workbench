/**
 * Claude accounts (Accounts page): the Claude Code setups found in its own configuration (see
 * claude-code-detection). Each project window has its own account in use (saved for its project);
 * while an API profile is in use, that profile is the one in use and no account is marked. Each row
 * shows the account's email and usage (or its provider); its menu switches to it (leaving an API
 * profile in use), signs it in again and shows its details; accounts not in use can be deleted from their row. Adding an account
 * (or signing one in again) runs Claude Code's own sign-in (`claude auth login`) in the user's
 * terminal; the accounts are then detected again until the sign-in shows up.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Info, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { SettingsRow } from './SettingsRow';
import { DetectedAccountDialog } from './DetectedAccountDialog';
import { useClaudeAccounts } from './hooks/useClaudeAccounts';
import { switchClaudeAccount, useWindowClaudeAccountId } from '../../hooks/useWindowClaudeAccount';
import { useSettingsStore } from '../../stores/settings-store';
import type { ClaudeProfile } from '../../../shared/types';

/** How often (and how long) the accounts are detected again while a sign-in runs in a terminal */
const LOGIN_WATCH_INTERVAL_MS = 3000;
const LOGIN_WATCH_MAX_TRIES = 200;

export function ClaudeAccountsSection() {
  const { t } = useTranslation('settings');
  const { profiles: allProfiles, activeProfileId, usage, reload } = useClaudeAccounts();
  // The account this window's project runs on
  const accountId = useWindowClaudeAccountId();
  // An API profile in use takes over from the Claude accounts: it alone is marked in use
  const apiProfileInUse = useSettingsStore((state) => state.activeProfileId);
  const setActiveApiProfile = useSettingsStore((state) => state.setActiveProfile);
  // Only Claude Code's own setups are accounts
  const profiles = allProfiles.filter((profile) => profile.detected);

  // Claude Code's sign-in running in the user's terminal: a new account, or one to sign in again
  const [login, setLogin] = useState<{ profileId?: string; known: Map<string, string> } | null>(null);
  // Status of adding an account, shown in the Add row
  const [addStatus, setAddStatus] = useState<{ message: string; error?: boolean } | null>(null);
  // Details (and name) of an account
  const [details, setDetails] = useState<{ open: boolean; profile?: ClaudeProfile }>({ open: false });
  const [busyId, setBusyId] = useState<string | null>(null);
  // The last failed action on an account, shown in its row instead of the description
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // The account whose deletion waits for confirmation
  const [deleteTarget, setDeleteTarget] = useState<ClaudeProfile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      // The account in use for projects without their own (not this window's): this window's account takes its place
      const replacement = deleteTarget.id === activeProfileId && accountId && accountId !== deleteTarget.id ? accountId : undefined;
      const result = await window.electronAPI.deleteClaudeProfile(deleteTarget.id, replacement);
      if (!result.success) {
        setDeleteError(result.error || t('claudeAccounts.toast.deleteFailed'));
        return;
      }
      setDeleteTarget(null);
      await reload();
    } catch {
      setDeleteError(t('claudeAccounts.toast.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUse = async (profile: ClaudeProfile) => {
    setBusyId(profile.id);
    setRowError(null);
    try {
      // Saved for this window's project; other windows keep their own account
      const result = profile.id === accountId ? { success: true } as const : await switchClaudeAccount(profile.id);
      if (!result.success) {
        const title = t('claudeAccounts.toast.switchFailed');
        setRowError({ id: profile.id, message: result.error ? `${title}: ${result.error}` : title });
      } else if (apiProfileInUse && !(await setActiveApiProfile(null))) {
        // Back from the API profile to Claude accounts
        setRowError({ id: profile.id, message: t('claudeAccounts.toast.switchFailed') });
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  // A sign-in account as detected: changes when Claude Code signs it in
  const signInState = (profile: ClaudeProfile) => JSON.stringify([profile.isAuthenticated, profile.email, profile.detected]);

  const startLogin = async (profile?: ClaudeProfile) => {
    setRowError(null);
    setAddStatus(null);
    const known = new Map(profiles.map((p) => [p.id, signInState(p)] as const));
    const result = await window.electronAPI.loginClaudeAccount(profile?.id);
    if (!result.success) {
      const message = result.error ?? t('claudeAccounts.login.failedToStart');
      if (profile) setRowError({ id: profile.id, message });
      else setAddStatus({ message, error: true });
      return;
    }
    if (!profile) setAddStatus({ message: t('claudeAccounts.login.waiting') });
    setLogin({ profileId: profile?.id, known });
  };

  // While the sign-in runs in the terminal, detect Claude Code's setups again until it shows up
  useEffect(() => {
    if (!login) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      tries++;
      const result = await window.electronAPI.redetectClaudeAccounts();
      if (stopped) return;
      const accounts = result.success && result.data
        ? result.data.profiles.filter((p) => p.detected?.provider === 'subscription' && p.isAuthenticated)
        : [];
      const signedIn = login.profileId
        ? accounts.find((p) => p.id === login.profileId && login.known.get(p.id) !== signInState(p))
        : accounts.find((p) => !login.known.has(p.id));
      const timedOut = tries >= LOGIN_WATCH_MAX_TRIES;
      if (!signedIn && !timedOut) return;
      clearInterval(timer);
      setLogin(null);
      if (!login.profileId) {
        setAddStatus(signedIn
          ? { message: signedIn.email ? t('claudeAccounts.login.signedInAs', { email: signedIn.email }) : t('claudeAccounts.login.signedIn') }
          : { message: t('claudeAccounts.login.notSignedIn') });
      }
      await reload();
    }, LOGIN_WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [login, reload, t]);

  // Only accounts that can be deleted show the delete button (on hover, like API profiles): not this
  // window's account, nor one set up from outside its config dir, which would be listed again. The
  // app's account in use (for projects without their own) can go when this window runs on another:
  // that one takes its place
  const canDelete = (profile: ClaudeProfile) =>
    profile.id !== accountId
    && !!accountId
    && !(profile.detected?.isDefaultDir && profile.detected.definedOutside);

  const describe = (profile: ClaudeProfile): string => {
    // A setup on a cloud provider, an API key or a gateway: what it reaches Claude through
    const detected = profile.detected;
    if (detected && detected.provider !== 'subscription') {
      const where = ['AWS_REGION', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_BASE_URL']
        .map((key) => detected.values.find((value) => value.key === key)?.value)
        .find(Boolean);
      return [t(`claudeAccounts.providers.${detected.provider}`), where].filter(Boolean).join(' · ');
    }
    const summary = usage.get(profile.id);
    // The account's own email first; the usage summary only fills in one it doesn't know
    const email = profile.email || summary?.profileEmail;
    const parts: string[] = [];
    if (profile.isAuthenticated === false && !summary?.isAuthenticated) {
      parts.push(t('claudeAccounts.notSignedIn'));
    } else if (email) {
      parts.push(email);
    }
    if (summary?.needsReauthentication) parts.push(t('claudeAccounts.needsSignIn'));
    if (summary?.isRateLimited) parts.push(t('claudeAccounts.rateLimited'));
    // Usage only once it was fetched for this account (lastFetchedAt): never placeholder zeros
    if (summary && summary.isAuthenticated && !summary.fetchError && summary.lastFetchedAt) {
      parts.push(t('claudeAccounts.usage', {
        session: Math.round(summary.sessionPercent),
        weekly: Math.round(summary.weeklyPercent)
      }));
    }
    return parts.join(' · ');
  };

  return (
    <>
      {profiles.map((profile) => {
        const isActive = !apiProfileInUse && profile.id === accountId;
        const isBusy = busyId === profile.id;
        return (
          <SettingsRow
            key={profile.id}
            className="group"
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{profile.name}</span>
                {isActive && <span className="shrink-0 text-(--nav-label-color)">{t('claudeAccounts.inUse')}</span>}
              </span>
            }
            description={
              rowError?.id === profile.id ? (
                <span role="alert" className="text-destructive">{rowError.message}</span>
              ) : (
                describe(profile) || undefined
              )
            }
          >
            {canDelete(profile) && (
              <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(profile);
                  }}
                  disabled={isBusy}
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  title={t('claudeAccounts.dialog.delete')}
                  aria-label={t('claudeAccounts.deleteAriaLabel', { name: profile.name })}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('h-8 w-8 text-muted-foreground', isBusy && 'pointer-events-none opacity-50')}
                  aria-label={t('claudeAccounts.menu', { name: profile.name })}
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem className="cursor-pointer" disabled={isActive} onSelect={() => void handleUse(profile)}>
                  <Check className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {isActive ? t('claudeAccounts.inUse') : t('claudeAccounts.use')}
                </DropdownMenuItem>
                {/* A subscription sign-in signs in again with Claude Code's own login */}
                {profile.detected?.provider === 'subscription' && (
                  <DropdownMenuItem className="cursor-pointer" onSelect={() => void startLogin(profile)}>
                    <RefreshCw className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                    {t('claudeAccounts.signInAgain')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="cursor-pointer" onSelect={() => setDetails({ open: true, profile })}>
                  <Info className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {t('claudeAccounts.details')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t('claudeAccounts.add')}
        description={
          addStatus ? (
            <span role={addStatus.error ? 'alert' : undefined} className={addStatus.error ? 'text-destructive' : undefined}>
              {addStatus.message}
            </span>
          ) : t('claudeAccounts.addDescription')
        }
      >
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void startLogin()}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('claudeAccounts.addButton')}
        </Button>
      </SettingsRow>

      <DetectedAccountDialog
        open={details.open}
        profile={details.profile}
        onOpenChange={(open) => setDetails((current) => ({ ...current, open }))}
        onSaved={() => void reload()}
      />

      {/* Confirm before the account is signed out and its configuration removed */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (isDeleting || open) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('claudeAccounts.dialog.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.detected?.isDefaultDir
                ? t('claudeAccounts.dialog.deleteDescriptionDefault', { name: deleteTarget.name })
                : t('claudeAccounts.dialog.deleteDescription', { name: deleteTarget?.name ?? '', dir: deleteTarget?.configDir ?? '' })}
            </AlertDialogDescription>
            {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('claudeAccounts.dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Stay open until the delete finishes, so a failure can be shown here
                e.preventDefault();
                void handleDelete();
              }}
              disabled={isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {isDeleting ? t('claudeAccounts.dialog.deleting') : t('claudeAccounts.dialog.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
