import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import type { BuiltinProvider } from '@shared/types/provider-account';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

const MAX_VISIBLE_TABS = 3;

interface ProviderTabBarProps {
  providers: BuiltinProvider[];
  activeProvider: BuiltinProvider | null;
  onProviderChange: (provider: BuiltinProvider) => void;
  showCrossProvider?: boolean;
  isCrossProviderActive?: boolean;
  onCrossProviderClick?: () => void;
  crossProviderDisabled?: boolean;
  needsSetup?: (provider: BuiltinProvider) => boolean;
}

// claude.ai segmented-control look: items sit on a translucent track, the active one is raised
const itemClass = (isActive: boolean) =>
  cn(
    'relative inline-flex h-full items-center gap-1 rounded-[7px] px-3 text-sm outline-none',
    'transition-[color,background-color,box-shadow] duration-75 focus-visible:shadow-(--shadow-focus)',
    isActive
      ? 'bg-segment-thumb text-foreground shadow-[inset_0_0_0_1px_var(--segment-thumb-ring),0_1px_2px_0_rgb(0_0_0/0.05)]'
      : 'text-muted-foreground hover:text-foreground'
  );

function getProviderDisplayName(provider: BuiltinProvider): string {
  const info = PROVIDER_REGISTRY.find((p) => p.id === provider);
  return info?.name ?? provider;
}

export function ProviderTabBar({
  providers,
  activeProvider,
  onProviderChange,
  showCrossProvider,
  isCrossProviderActive,
  onCrossProviderClick,
  crossProviderDisabled,
  needsSetup,
}: ProviderTabBarProps) {
  const { t } = useTranslation('settings');

  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('agentProfile.providerTabs.noProviders')}
      </p>
    );
  }

  const visibleProviders = providers.slice(0, MAX_VISIBLE_TABS);
  const overflowProviders = providers.slice(MAX_VISIBLE_TABS);
  const hasOverflow = overflowProviders.length > 0;
  const isActiveInOverflow =
    hasOverflow && activeProvider !== null && overflowProviders.includes(activeProvider);

  return (
    <div
      role="tablist"
      aria-label={t('agentProfile.providerTabs.label')}
      className="inline-flex h-8 w-fit max-w-full shrink-0 items-stretch rounded-lg bg-segment-track p-px"
    >
      {visibleProviders.map((provider) => {
        const isActive = provider === activeProvider;
        const showSetupDot = needsSetup?.(provider) ?? false;
        return (
          <button
            key={provider}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onProviderChange(provider)}
            className={itemClass(isActive)}
          >
            {getProviderDisplayName(provider)}
            {showSetupDot && (
              <span
                className="ml-0.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-(--error)"
                title={t('agentProfile.providerTabs.needsSetup')}
                aria-label={t('agentProfile.providerTabs.needsSetup')}
              />
            )}
          </button>
        );
      })}

      {hasOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              role="tab"
              aria-selected={isActiveInOverflow}
              className={itemClass(isActiveInOverflow)}
            >
              {isActiveInOverflow && activeProvider !== null
                ? getProviderDisplayName(activeProvider)
                : t('agentProfile.providerTabs.moreProviders')}
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflowProviders.map((provider) => (
              <DropdownMenuItem
                key={provider}
                onClick={() => onProviderChange(provider)}
                className={cn(
                  'relative',
                  provider === activeProvider && 'bg-nav-active text-foreground'
                )}
              >
                {getProviderDisplayName(provider)}
                {needsSetup?.(provider) && (
                  <span
                    className="ml-2 inline-flex h-1.5 w-1.5 rounded-full bg-(--error) shrink-0"
                    aria-label={t('agentProfile.providerTabs.needsSetup')}
                  />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showCrossProvider && (
        crossProviderDisabled ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex h-full cursor-not-allowed items-center px-3 text-sm text-muted-foreground/50">
                  {t('agentProfile.providerTabs.crossProvider')}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{t('agentProfile.providerTabs.crossProviderDisabledTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <button
            type="button"
            role="tab"
            aria-selected={!!isCrossProviderActive}
            onClick={onCrossProviderClick}
            className={itemClass(!!isCrossProviderActive)}
          >
            {t('agentProfile.providerTabs.crossProvider')}
          </button>
        )
      )}
    </div>
  );
}
