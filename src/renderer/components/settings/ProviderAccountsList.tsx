import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings-store';
import { useToast } from '../../hooks/use-toast';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import { ProviderSection } from './ProviderSection';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { AddAccountDialog } from './AddAccountDialog';
import { buttonVariants } from '../ui/button';
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
import type { BillingModel, BuiltinProvider, ProviderAccount, ProviderCategory } from '@shared/types/provider-account';

export function ProviderAccountsList() {
  const { t } = useTranslation('settings');
  const {
    deleteProviderAccount,
    updateProviderAccount,
    providerAccounts,
    checkEnvCredentials,
    loadProviderAccounts,
    envCredentials,
    setQueueOrder,
  } = useSettingsStore();
  const priorityOrder = useSettingsStore((state) => state.settings.globalPriorityOrder);
  const { toast } = useToast();

  const [isLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // AddAccountDialog state
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    provider: BuiltinProvider;
    authType: 'oauth' | 'api-key';
    billingModel?: BillingModel;
    editAccount?: ProviderAccount;
  }>({
    open: false,
    provider: 'anthropic',
    authType: 'api-key',
  });

  // Load provider accounts and check env credentials on mount
  useEffect(() => {
    loadProviderAccounts().catch(() => {
      // Non-fatal - accounts may already be loaded from settings init
    });
    checkEnvCredentials().catch(() => {
      // Non-fatal
    });
  }, [loadProviderAccounts, checkEnvCredentials]);

  const allAccounts = providerAccounts;

  // Agents use a provider's first account in the priority order (accounts missing from the
  // saved order come after it, in their natural order)
  const effectiveOrder = [
    ...(priorityOrder ?? []).filter((id) => allAccounts.some((a) => a.id === id)),
    ...allAccounts.map((a) => a.id).filter((id) => !(priorityOrder ?? []).includes(id)),
  ];
  const activeAccountId = (provider: BuiltinProvider) =>
    effectiveOrder.find((id) => allAccounts.find((a) => a.id === id)?.provider === provider);

  // Default provider: the provider of the first account in the order. Agents use it; other
  // providers' accounts are only fallbacks when it's unavailable (rate limited, failing auth)
  const defaultProvider = effectiveOrder.length > 0
    ? allAccounts.find((a) => a.id === effectiveOrder[0])?.provider
    : undefined;
  const providersWithAccounts = PROVIDER_REGISTRY.filter((p) => allAccounts.some((a) => a.provider === p.id));

  // Choosing a default provider moves its selected account to the front of the order
  const handleDefaultProviderChange = async (provider: string) => {
    const accountId = activeAccountId(provider as BuiltinProvider);
    if (!accountId || effectiveOrder[0] === accountId) return;
    const result = await setQueueOrder([accountId, ...effectiveOrder.filter((id) => id !== accountId)]);
    if (!result.success) {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    }
  };

  // Selecting an account moves it ahead of the provider's other accounts only, so the order
  // of other providers (and which provider comes first) stays the same
  const handleSelectAccount = async (account: ProviderAccount) => {
    const currentId = activeAccountId(account.provider);
    if (!currentId || currentId === account.id) return;
    const rest = effectiveOrder.filter((id) => id !== account.id);
    rest.splice(rest.indexOf(currentId), 0, account.id);
    const result = await setQueueOrder(rest);
    if (!result.success) {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    }
  };

  // Group accounts by provider, preserving PROVIDER_REGISTRY order
  const accountsByProvider = PROVIDER_REGISTRY.reduce<Map<BuiltinProvider, ProviderAccount[]>>(
    (map, p) => {
      map.set(p.id, allAccounts.filter(a => a.provider === p.id));
      return map;
    },
    new Map()
  );

  // Sort: providers with accounts first within each category, then empty
  const sortedProviders = [...PROVIDER_REGISTRY].sort((a, b) => {
    const aCount = accountsByProvider.get(a.id)?.length ?? 0;
    const bCount = accountsByProvider.get(b.id)?.length ?? 0;
    if (aCount > 0 && bCount === 0) return -1;
    if (aCount === 0 && bCount > 0) return 1;
    return 0;
  });

  const CATEGORY_ORDER: { key: ProviderCategory; labelKey: string }[] = [
    { key: 'popular', labelKey: 'providers.categories.popular' },
    { key: 'infrastructure', labelKey: 'providers.categories.infrastructure' },
    { key: 'local', labelKey: 'providers.categories.local' },
  ];

  const categories = CATEGORY_ORDER.map(({ key, labelKey }) => {
    const providers = sortedProviders.filter(p => p.category === key);
    return { key, label: t(labelKey), providers };
  });

  const handleAddAccount = (provider: BuiltinProvider, authType: 'oauth' | 'api-key', billingModel?: BillingModel) => {
    setDialogState({ open: true, provider, authType, billingModel });
  };

  const handleEditAccount = (account: ProviderAccount) => {
    setDialogState({
      open: true,
      provider: account.provider,
      authType: account.authType,
      editAccount: account,
    });
  };

  const handleDeleteAccount = (id: string) => {
    setDeleteTarget(id);
  };

  const handleReauthAccount = useCallback(async (account: ProviderAccount) => {
    if (account.authType !== 'oauth') return;

    const isCodex = account.provider === 'openai';

    const refreshUsageData = async () => {
      try {
        await window.electronAPI.requestAllProfilesUsage?.(true);
      } catch {
        // Non-fatal. Usage will refresh on next polling cycle.
      }
    };

    if (isCodex) {
      // Codex OAuth: trigger re-auth flow directly
      try {
        toast({ title: t('providers.toast.reauthStarted') });
        const result = await window.electronAPI.codexAuthLogin();
        if (result.success) {
          if (result.data?.email) {
            await updateProviderAccount(account.id, { email: result.data.email });
          }
          await refreshUsageData();
          toast({ title: t('providers.toast.reauthSuccess'), description: account.name });
        } else {
          toast({ variant: 'destructive', title: t('providers.toast.reauthFailed'), description: result.error ?? '' });
        }
      } catch (err) {
        toast({ variant: 'destructive', title: t('providers.toast.reauthFailed'), description: err instanceof Error ? err.message : '' });
      }
    } else if (account.claudeProfileId) {
      // Anthropic OAuth: trigger re-auth via subprocess
      try {
        toast({ title: t('providers.toast.reauthStarted') });
        const result = await window.electronAPI.claudeAuthLoginSubprocess(account.claudeProfileId);
        if (result.success && result.data?.authenticated) {
          if (result.data.email) {
            await updateProviderAccount(account.id, { email: result.data.email });
          }
          await refreshUsageData();
          toast({ title: t('providers.toast.reauthSuccess'), description: account.name });
        } else {
          toast({ variant: 'destructive', title: t('providers.toast.reauthFailed'), description: result.error ?? '' });
        }
      } catch (err) {
        toast({ variant: 'destructive', title: t('providers.toast.reauthFailed'), description: err instanceof Error ? err.message : '' });
      }
    }
  }, [toast, t, updateProviderAccount]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = await deleteProviderAccount(deleteTarget);
      if (result.success) {
        toast({
          title: t('providers.toast.deleted'),
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('providers.toast.deleteFailed'),
          description: result.error ?? t('accounts.toast.tryAgain'),
        });
      }
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      {providersWithAccounts.length > 0 && (
        <SettingsSection title={t('providers.default.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('providers.default.label')}
              description={t('providers.default.description')}
              htmlFor="default-provider"
            >
              <Select value={defaultProvider ?? ''} onValueChange={handleDefaultProviderChange}>
                <SelectTrigger id="default-provider" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providersWithAccounts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsRows>
        </SettingsSection>
      )}

      {categories.map(({ key, label, providers: categoryProviders }) => {
        if (categoryProviders.length === 0) return null;
        return (
          <SettingsSection key={key} title={label}>
            <SettingsRows>
              {categoryProviders.map((providerInfo) => {
                const accounts = accountsByProvider.get(providerInfo.id) ?? [];
                const envDetected = providerInfo.envVars.some(v => envCredentials?.[v]);
                return (
                  <ProviderSection
                    key={providerInfo.id}
                    provider={providerInfo}
                    accounts={accounts}
                    activeAccountId={activeAccountId(providerInfo.id)}
                    onSelectAccount={handleSelectAccount}
                    envDetected={envDetected}
                    onAddAccount={handleAddAccount}
                    onEditAccount={handleEditAccount}
                    onDeleteAccount={handleDeleteAccount}
                    onReauthAccount={handleReauthAccount}
                  />
                );
              })}
            </SettingsRows>
          </SettingsSection>
        );
      })}

      {/* Add / Edit dialog */}
      <AddAccountDialog
        open={dialogState.open}
        onOpenChange={(open) => setDialogState(s => ({ ...s, open }))}
        provider={dialogState.provider}
        authType={dialogState.authType}
        billingModel={dialogState.billingModel}
        editAccount={dialogState.editAccount}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('providers.dialog.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('providers.dialog.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('providers.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  {t('providers.dialog.deleting')}
                </>
              ) : (
                t('providers.dialog.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
