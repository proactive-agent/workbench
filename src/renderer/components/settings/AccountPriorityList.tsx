/**
 * AccountPriorityList - Unified drag-and-drop priority list with usage visualization
 *
 * Displays ALL accounts in a single, unified priority list. Position determines
 * fallback order - the system uses accounts from top to bottom.
 *
 * Supports all user scenarios:
 * - OAuth accounts as primary with API fallback
 * - API endpoints as primary with OAuth fallback
 * - Any mix of providers in any order
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  Check,
  Infinity,
  AlertCircle,
  Clock,
  TrendingUp
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';

/**
 * Usage threshold constants for color coding (matching UsageIndicator)
 */
const THRESHOLD_CRITICAL = 95;  // Red: At or near limit
const THRESHOLD_WARNING = 91;   // Orange: Very high usage
const THRESHOLD_ELEVATED = 71;  // Yellow: Moderate usage

const getProviderDisplayName = (provider?: string): string => {
  return PROVIDER_REGISTRY.find((entry) => entry.id === provider)?.name ?? provider ?? 'Unknown';
};

/**
 * Get status label key based on usage
 */
const getStatusKey = (sessionPercent?: number, weeklyPercent?: number, isRateLimited?: boolean): string => {
  const atOrBeyondLimit = (sessionPercent ?? 0) >= 100 || (weeklyPercent ?? 0) >= 100;
  if (isRateLimited || atOrBeyondLimit) return 'rateLimited';
  const maxPercent = Math.max(sessionPercent ?? 0, weeklyPercent ?? 0);
  if (maxPercent >= THRESHOLD_CRITICAL) return 'nearLimit';
  if (maxPercent >= THRESHOLD_WARNING) return 'highUsage';
  if (maxPercent >= THRESHOLD_ELEVATED) return 'moderate';
  return 'healthy';
};

/**
 * Unified account representation for the priority list
 */
export interface UnifiedAccount {
  id: string;
  name: string;
  type: 'oauth' | 'api';
  provider?: string;
  displayName: string;
  identifier: string; // email for OAuth, baseUrl for API
  isActive: boolean;  // TRUE only for the ONE account currently in use
  isNext: boolean;
  isAvailable: boolean;
  hasUnlimitedUsage: boolean;
  sessionPercent?: number;
  weeklyPercent?: number;
  isRateLimited?: boolean;
  rateLimitType?: 'session' | 'weekly';
  isAuthenticated?: boolean;
  /** Set when this account has identical usage to another - may indicate same underlying account */
  isDuplicateUsage?: boolean;
  /** Set when this account has an invalid refresh token and needs re-authentication */
  needsReauthentication?: boolean;
  /** Best-effort account-level identity used to reduce duplicate false positives */
  profileEmail?: string;
}

interface SortableAccountItemProps {
  account: UnifiedAccount;
  index: number;
  onSetActive?: (accountId: string) => void;
}

function SortableAccountItem({ account, index, onSetActive }: SortableAccountItemProps) {
  const { t } = useTranslation('settings');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: account.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined
  };

  const statusKey = getStatusKey(account.sessionPercent, account.weeklyPercent, account.isRateLimited);
  const isStatusCritical = statusKey === 'nearLimit' || statusKey === 'rateLimited';

  const metaParts = [
    getProviderDisplayName(account.provider),
    account.type === 'oauth' ? t('accounts.priority.typeOAuth') : t('accounts.priority.typeAPI'),
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative flex items-center gap-3 bg-background py-3',
        isDragging && 'rounded-lg opacity-80 shadow-lg',
        !account.isAvailable && 'opacity-60'
      )}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('accounts.priority.dragHandle')}
        className="-ml-1 cursor-grab rounded p-1 text-(--nav-label-color) outline-none hover:text-foreground focus-visible:shadow-(--shadow-focus) active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" strokeWidth={1.75} />
      </button>

      {/* Priority number */}
      <span className="w-4 shrink-0 text-center text-sm tabular-nums text-(--nav-label-color)">
        {index + 1}
      </span>

      {/* Account info and usage */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm text-foreground">{account.displayName}</span>
          <span className="text-sm text-(--nav-label-color)">{metaParts.join(' · ')}</span>
        </div>
        <span className="block truncate text-sm text-(--nav-label-color)">{account.identifier}</span>

        {/* Usage for OAuth accounts */}
        {account.type === 'oauth' && account.isAvailable && account.sessionPercent !== undefined && (
          <div className="mt-1 flex items-center gap-4 text-xs text-(--nav-label-color)">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {Math.round(account.sessionPercent)}%
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('accounts.priority.sessionUsage')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <TrendingUp className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {Math.round(account.weeklyPercent ?? 0)}%
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('accounts.priority.weeklyUsage')}
              </TooltipContent>
            </Tooltip>
            <span className={cn(isStatusCritical && 'text-destructive')}>
              {t(`accounts.priority.status.${statusKey}`)}
            </span>
          </div>
        )}

        {/* OAuth account not authenticated */}
        {account.type === 'oauth' && !account.isAvailable && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('accounts.priority.needsAuth')}
          </div>
        )}

        {/* Duplicate usage warning - may indicate same underlying OAuth account */}
        {account.type === 'oauth' && account.isDuplicateUsage && account.isAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex w-fit cursor-help items-center gap-1.5 text-xs text-(--nav-label-color)">
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('accounts.priority.duplicateUsage')}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[250px] text-xs">
              {t('accounts.priority.duplicateUsageHint')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Needs re-authentication warning - invalid refresh token */}
        {account.type === 'oauth' && account.needsReauthentication && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex w-fit cursor-help items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('accounts.priority.needsReauth')}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[250px] text-xs">
              {t('accounts.priority.needsReauthHint')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Right side: status / actions */}
      <div className="flex shrink-0 items-center gap-2 text-sm text-(--nav-label-color)">
        {account.type === 'api' && (
          <span className="flex items-center gap-1">
            <Infinity className="h-4 w-4" strokeWidth={1.75} />
            {t('accounts.priority.payPerUse')}
          </span>
        )}
        {account.isActive ? (
          <span className="flex items-center gap-1.5 text-foreground">
            <Check className="h-4 w-4" strokeWidth={1.75} />
            {t('accounts.priority.inUse')}
          </span>
        ) : (
          <>
            {account.isNext && <span>{t('accounts.priority.next')}</span>}
            {onSetActive && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSetActive(account.id)}
                  >
                    {t('accounts.priority.setActive')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('accounts.priority.setActiveTooltip')}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface AccountPriorityListProps {
  accounts: UnifiedAccount[];
  onReorder: (newOrder: string[]) => void;
  onSetActive?: (accountId: string) => void;
  isLoading?: boolean;
}

export function AccountPriorityList({ accounts, onReorder, onSetActive, isLoading }: AccountPriorityListProps) {
  const { t } = useTranslation('settings');
  const [items, setItems] = useState<UnifiedAccount[]>(accounts);

  // Sync with external accounts prop
  useEffect(() => {
    setItems(accounts);
  }, [accounts]);

  // Determine "next" account - first available account after the active one
  const nextAccountId = useMemo(() => {
    const activeIndex = items.findIndex(a => a.isActive);
    if (activeIndex === -1) {
      // No active account - first available is "next"
      return items.find(a => a.isAvailable)?.id ?? null;
    }
    for (let i = activeIndex + 1; i < items.length; i++) {
      if (items[i].isAvailable && !items[i].isActive) {
        return items[i].id;
      }
    }
    // Wrap around to beginning if needed
    for (let i = 0; i < activeIndex; i++) {
      if (items[i].isAvailable && !items[i].isActive) {
        return items[i].id;
      }
    }
    return null;
  }, [items]);

  // Detect duplicate usage - OAuth accounts with identical non-zero usage may be the same underlying account.
  // Prefer matching by provider + profile email when available to reduce false positives.
  const duplicateUsageIds = useMemo(() => {
    const duplicates = new Set<string>();
    const oauthAccounts = items.filter(a => a.type === 'oauth' && a.isAvailable);

    // Only check if we have 2+ OAuth accounts with usage data
    if (oauthAccounts.length < 2) return duplicates;

    // Build usage signature map
    const usageSignatures = new Map<string, string[]>();
    for (const account of oauthAccounts) {
      // Create a signature from usage percentages
      // Only consider it a duplicate if both session and weekly are defined and non-zero
      if (account.sessionPercent !== undefined && account.weeklyPercent !== undefined) {
        // Skip if both are 0 (could be new accounts or accounts with reset usage)
        if (account.sessionPercent === 0 && account.weeklyPercent === 0) continue;

        const normalizedEmail = account.profileEmail?.trim().toLowerCase();
        const providerPrefix = (account.provider ?? 'oauth').toLowerCase();
        const signature = normalizedEmail
          ? `${providerPrefix}:email:${normalizedEmail}:${account.sessionPercent}-${account.weeklyPercent}`
          : `${providerPrefix}:usage:${account.sessionPercent}-${account.weeklyPercent}`;
        const existing = usageSignatures.get(signature) ?? [];
        existing.push(account.id);
        usageSignatures.set(signature, existing);
      }
    }

    // Mark accounts with duplicate signatures
    for (const [, ids] of usageSignatures) {
      if (ids.length > 1) {
        ids.forEach(id => duplicates.add(id));
      }
    }

    return duplicates;
  }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((currentItems) => {
        const oldIndex = currentItems.findIndex((item) => item.id === active.id);
        const newIndex = currentItems.findIndex((item) => item.id === over.id);
        const newItems = arrayMove(currentItems, oldIndex, newIndex);

        // Notify parent of new order
        onReorder(newItems.map(item => item.id));

        return newItems;
      });
    }
  }, [onReorder]);

  if (items.length === 0) {
    return (
      <p className="py-3 text-sm text-(--nav-label-color)">{t('accounts.priority.noAccounts')}</p>
    );
  }

  return (
    <div className="space-y-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={items.map(item => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className={cn(
            '[&>*+*]:border-t [&>*+*]:border-settings-divider',
            isLoading && 'pointer-events-none opacity-50'
          )}>
            {items.map((account, index) => (
              <SortableAccountItem
                key={account.id}
                account={{
                  ...account,
                  isNext: account.id === nextAccountId,
                  isDuplicateUsage: duplicateUsageIds.has(account.id)
                }}
                index={index}
                onSetActive={onSetActive}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Explanatory tip - provider agnostic */}
      <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
        <p className="text-foreground">{t('accounts.priority.tipTitle')}</p>
        <p className="mt-1 text-(--nav-label-color)">{t('accounts.priority.tipDescription')}</p>
      </div>
    </div>
  );
}
