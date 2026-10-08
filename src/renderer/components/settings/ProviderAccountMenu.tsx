import { useTranslation } from 'react-i18next';
import { Check, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu';
import type { ProviderAccount } from '@shared/types/provider-account';

interface ProviderAccountMenuProps {
  account: ProviderAccount;
  /** This is the account agents use for the provider */
  isActive: boolean;
  onSelect: (account: ProviderAccount) => void;
  onEdit: (account: ProviderAccount) => void;
  onDelete: (id: string) => void;
  onReauth?: (account: ProviderAccount) => void;
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(Math.max(8, key.length - 8))}${key.slice(-4)}`;
}

/**
 * One account in a provider's dropdown: its name, auth type and identifier (email, endpoint or
 * masked key), checked when it's the account in use. Clicking it selects it; its submenu has
 * use / re-authenticate / edit / delete.
 */
export function ProviderAccountMenu({ account, isActive, onSelect, onEdit, onDelete, onReauth }: ProviderAccountMenuProps) {
  const { t } = useTranslation('settings');

  const isOAuth = account.authType === 'oauth';
  const isCodex = isOAuth && account.provider === 'openai';
  const isClaudeCode = isOAuth && account.provider === 'anthropic';
  const isZaiCodingPlan = account.provider === 'zai' && account.billingModel === 'subscription';

  const authBadgeLabel = isCodex
    ? t('providers.card.codex')
    : isClaudeCode
      ? t('providers.card.claudeCode')
      : isZaiCodingPlan
        ? t('providers.card.zaiCodingPlan')
        : isOAuth
          ? t('providers.card.oauth')
          : account.provider === 'zai'
            ? t('providers.card.zaiUsageBased')
            : t('providers.card.apiKey');

  const identifier = isCodex
    ? (account.email || t('providers.card.codexSubscription'))
    : isClaudeCode
      ? (account.email || t('providers.card.claudeCodeSubscription'))
      : isZaiCodingPlan
        ? (account.email || t('providers.card.zaiCodingPlanSubscription'))
        : isOAuth
          ? (account.email || (account.usage ? t('providers.card.oauthLinked') : t('providers.card.oauthAccount')))
          : account.apiKey
            ? maskKey(account.apiKey)
            : account.baseUrl ?? t('providers.card.noEndpoint');

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="cursor-pointer" onClick={() => onSelect(account)}>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {isActive && <Check className="h-4 w-4 text-(--menu-check)" strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm text-foreground">{account.name}</span>
            <span className="shrink-0 text-sm text-(--nav-label-color)">{authBadgeLabel}</span>
          </div>
          <div className="truncate text-[0.8125rem] text-(--nav-label-color)">{identifier}</div>
        </div>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={6} className="w-48">
        <DropdownMenuItem className="cursor-pointer" disabled={isActive} onSelect={() => onSelect(account)}>
          <Check className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
          {isActive ? t('providers.card.inUse') : t('providers.card.useAccount')}
        </DropdownMenuItem>
        {isOAuth && onReauth && (
          <DropdownMenuItem className="cursor-pointer" onSelect={() => onReauth(account)}>
            <RefreshCw className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
            {t('providers.card.reauth')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="cursor-pointer" onSelect={() => onEdit(account)}>
          <Pencil className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
          {t('providers.card.edit')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onDelete(account.id)}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          {t('providers.card.delete')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
