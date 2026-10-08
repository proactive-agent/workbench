import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { SettingsRow, SETTINGS_MENU_TRIGGER_CLASS } from './SettingsRow';
import { ProviderAccountMenu } from './ProviderAccountMenu';
import { OllamaConnectionPanel } from './OllamaConnectionPanel';
import type { BillingModel, BuiltinProvider, ProviderAccount, ProviderInfo } from '@shared/types/provider-account';

interface ProviderSectionProps {
  provider: ProviderInfo;
  accounts: ProviderAccount[];
  /** The account agents use for this provider */
  activeAccountId?: string;
  onSelectAccount: (account: ProviderAccount) => void;
  envDetected: boolean;
  onAddAccount: (provider: BuiltinProvider, authType: 'oauth' | 'api-key', billingModel?: BillingModel) => void;
  onEditAccount: (account: ProviderAccount) => void;
  onDeleteAccount: (id: string) => void;
  onReauthAccount?: (account: ProviderAccount) => void;
}

/**
 * A provider row (claude.ai settings style): name + muted description on the left and a
 * dropdown on the right showing the account in use. The dropdown lists the connected accounts
 * (click to use one; hover for re-authenticate / edit / delete) and the add-account actions.
 */
export function ProviderSection({
  provider,
  accounts,
  activeAccountId,
  onSelectAccount,
  envDetected,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onReauthAccount,
}: ProviderSectionProps) {
  const { t } = useTranslation('settings');
  const [menuOpen, setMenuOpen] = useState(false);

  const hasOAuth = provider.authMethods.includes('oauth');
  const hasApiKey = provider.authMethods.includes('api-key');
  const isOllama = provider.id === 'ollama';

  // Add-account actions offered by this provider (Ollama accounts come from its connection panel)
  const addActions: { key: string; label: string; onSelect: () => void }[] = [];
  if (!isOllama) {
    if (hasOAuth) {
      addActions.push({
        key: 'oauth',
        label:
          provider.id === 'openai'
            ? t('providers.section.addCodexSubscription')
            : provider.id === 'anthropic'
              ? t('providers.section.addClaudeCode')
              : t('providers.section.addOAuth'),
        onSelect: () => onAddAccount(provider.id, 'oauth'),
      });
    }
    // Z.AI: Coding Plan subscription before the generic API key
    if (provider.id === 'zai' && hasApiKey) {
      addActions.push({
        key: 'coding-plan',
        label: t('providers.section.addCodingPlan'),
        onSelect: () => onAddAccount(provider.id, 'api-key', 'subscription'),
      });
    }
    if (hasApiKey) {
      addActions.push({
        key: 'api-key',
        label: provider.id === 'zai' ? t('providers.section.addUsageBased') : t('providers.section.addApiKey'),
        onSelect: () => onAddAccount(provider.id, 'api-key'),
      });
    }
    // No-key providers with a base URL
    if (!hasOAuth && !hasApiKey && provider.configFields.includes('baseUrl')) {
      addActions.push({
        key: 'endpoint',
        label: t('providers.section.addEndpoint'),
        onSelect: () => onAddAccount(provider.id, 'api-key'),
      });
    }
  }

  const activeAccount = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  const triggerLabel =
    activeAccount
      ? activeAccount.name
      : envDetected
        ? t('providers.section.envDetected')
        : t('providers.section.noAccountsShort');

  return (
    <SettingsRow
      label={provider.name}
      description={provider.description}
      footer={isOllama ? <OllamaConnectionPanel accounts={accounts} /> : undefined}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label={t('providers.section.accountsMenu', { provider: provider.name })}
          className={SETTINGS_MENU_TRIGGER_CLASS}
        >
          {triggerLabel}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {accounts.map((account) => (
            <ProviderAccountMenu
              key={account.id}
              account={account}
              isActive={account.id === activeAccount?.id}
              onSelect={(selected) => {
                onSelectAccount(selected);
                setMenuOpen(false);
              }}
              onEdit={onEditAccount}
              onDelete={onDeleteAccount}
              onReauth={onReauthAccount}
            />
          ))}

          {accounts.length === 0 && (
            <DropdownMenuItem disabled className="text-(--nav-label-color)">
              {envDetected
                ? t('providers.section.envCredentialDetected', { envVar: provider.envVars[0] })
                : t('providers.section.noAccounts')}
            </DropdownMenuItem>
          )}

          {addActions.length > 0 && <DropdownMenuSeparator />}
          {addActions.map((action) => (
            <DropdownMenuItem key={action.key} className="cursor-pointer" onSelect={action.onSelect}>
              <Plus className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
