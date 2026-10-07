import type { ComponentType } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  Clock,
  TrendingUp,
  Eye,
  EyeOff,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import type { ProviderAccount } from '@shared/types/provider-account';

interface ProviderAccountCardProps {
  account: ProviderAccount;
  onEdit: (account: ProviderAccount) => void;
  onDelete: (id: string) => void;
  onReauth?: (account: ProviderAccount) => void;
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(Math.max(8, key.length - 8))}${key.slice(-4)}`;
}

function UsageBar({ percent, icon: Icon, tooltipKey }: {
  percent: number;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  tooltipKey: string;
}) {
  const { t } = useTranslation('settings');
  const isCritical = percent >= 95;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-(--nav-label-color)" strokeWidth={1.75} />
          <div className="h-1 w-12 overflow-hidden rounded-full bg-segment-track">
            <div
              className={cn('h-full rounded-full', isCritical ? 'bg-destructive' : 'bg-foreground/60')}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
          <span className={cn('w-8 text-xs tabular-nums', isCritical ? 'text-destructive' : 'text-(--nav-label-color)')}>
            {Math.round(percent)}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{t(tooltipKey)}</TooltipContent>
    </Tooltip>
  );
}

export function ProviderAccountCard({ account, onEdit, onDelete, onReauth }: ProviderAccountCardProps) {
  const { t } = useTranslation('settings');
  const [showKey, setShowKey] = useState(false);

  const isOAuth = account.authType === 'oauth';
  const isCodex = isOAuth && account.provider === 'openai';
  const isClaudeCode = isOAuth && account.provider === 'anthropic';
  const isZaiCodingPlan = account.provider === 'zai' && account.billingModel === 'subscription';
  const sessionPercent = account.usage?.sessionUsagePercent ?? 0;
  const weeklyPercent = account.usage?.weeklyUsagePercent ?? 0;
  const hasUsage = (isOAuth || isZaiCodingPlan) && (sessionPercent > 0 || weeklyPercent > 0);

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
          : account.baseUrl ?? t('providers.card.noEndpoint');

  return (
    <div className="flex items-center justify-between gap-7 py-3">
      {/* Left: name + auth type + identifier */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm text-foreground">{account.name}</span>
          <span className="shrink-0 text-sm text-(--nav-label-color)">{authBadgeLabel}</span>
        </div>

        {!isOAuth && account.apiKey ? (
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs text-(--nav-label-color)">
              {showKey ? account.apiKey : maskKey(account.apiKey)}
            </span>
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="rounded text-(--nav-label-color) outline-none hover:text-foreground focus-visible:shadow-(--shadow-focus)"
              aria-label={showKey ? t('providers.card.hideKey') : t('providers.card.showKey')}
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
            </button>
          </div>
        ) : (
          <span className="block truncate text-sm text-(--nav-label-color)">{identifier}</span>
        )}

        {/* Custom models count for openai-compatible */}
        {account.provider === 'openai-compatible' && account.customModels && account.customModels.length > 0 && (
          <span className="block text-xs text-(--nav-label-color)">
            {t('providers.card.customModels', { count: account.customModels.length })}
          </span>
        )}

        {/* Usage for subscription accounts */}
        {hasUsage && (
          <div className="mt-1 flex items-center gap-4">
            <UsageBar percent={sessionPercent} icon={Clock} tooltipKey="accounts.priority.sessionUsage" />
            <UsageBar percent={weeklyPercent} icon={TrendingUp} tooltipKey="accounts.priority.weeklyUsage" />
          </div>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex shrink-0 items-center gap-1">
        {isOAuth && onReauth && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onReauth(account)}
                aria-label={t('providers.card.reauth')}
                className="h-8 w-8 text-(--nav-label-color) hover:text-foreground"
              >
                <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('providers.card.reauth')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(account.id)}
              aria-label={t('providers.card.delete')}
              className="h-8 w-8 text-(--nav-label-color) hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('providers.card.delete')}</TooltipContent>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={() => onEdit(account)} className="ml-1">
          {t('providers.card.editButton')}
        </Button>
      </div>
    </div>
  );
}
