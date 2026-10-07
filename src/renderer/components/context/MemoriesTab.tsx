import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { MemoryCard } from './MemoryCard';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { memoryFilterCategories, type MemoryFilterCategory } from './constants';
import type { MemorySystemStatus, MemorySystemState, RendererMemory } from '../../../shared/types';

interface MemoriesTabProps {
  memoryStatus: MemorySystemStatus | null;
  memoryState: MemorySystemState | null;
  recentMemories: RendererMemory[];
  memoriesLoading: boolean;
  searchResults: Array<{ type: string; content: string; score: number }>;
  searchLoading: boolean;
  onSearch: (query: string) => void;
  onVerify?: (memoryId: string) => void;
  onPin?: (memoryId: string, pinned: boolean) => void;
  onDeprecate?: (memoryId: string) => void;
}

// Get the effective category for a memory based on its type
function getMemoryCategory(memory: RendererMemory): MemoryFilterCategory {
  const type = memory.type;

  // Patterns
  if (['pattern', 'workflow_recipe', 'prefetch_pattern'].includes(type)) return 'patterns';

  // Errors & Gotchas
  if (['error_pattern', 'dead_end', 'gotcha'].includes(type)) return 'errors';

  // Decisions
  if (['decision', 'preference', 'requirement'].includes(type)) return 'decisions';

  // Code Insights
  if (['module_insight', 'causal_dependency', 'e2e_observation'].includes(type)) return 'insights';

  // Calibration
  if (['task_calibration', 'work_unit_outcome', 'work_state', 'context_cost'].includes(type))
    return 'calibration';

  return 'calibration'; // default
}


export function MemoriesTab({
  memoryStatus,
  memoryState,
  recentMemories,
  memoriesLoading,
  searchResults,
  searchLoading,
  onSearch,
  onVerify,
  onPin,
  onDeprecate
}: MemoriesTabProps) {
  const { t } = useTranslation(['common', 'settings']);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<MemoryFilterCategory>('all');

  // Calculate memory counts by category
  const memoryCounts = useMemo(() => {
    const counts: Record<MemoryFilterCategory, number> = {
      all: recentMemories.length,
      patterns: 0,
      errors: 0,
      decisions: 0,
      insights: 0,
      calibration: 0
    };

    for (const memory of recentMemories) {
      const category = getMemoryCategory(memory);
      counts[category]++;
    }

    return counts;
  }, [recentMemories]);

  // Memory health metrics
  const memoryHealth = useMemo(() => {
    if (recentMemories.length === 0) return null;
    const avgConfidence =
      recentMemories.reduce((sum, m) => sum + (m.confidence ?? 0), 0) / recentMemories.length;
    const verifiedCount = recentMemories.filter((m) => m.userVerified).length;
    return {
      avgConfidence: Math.round(avgConfidence * 100),
      verifiedCount,
      verifiedPct: Math.round((verifiedCount / recentMemories.length) * 100)
    };
  }, [recentMemories]);

  // Filter memories based on active filter
  const filteredMemories = useMemo(() => {
    if (activeFilter === 'all') return recentMemories;
    return recentMemories.filter((memory) => getMemoryCategory(memory) === activeFilter);
  }, [recentMemories, activeFilter]);

  const handleSearch = () => {
    if (localSearchQuery.trim()) {
      onSearch(localSearchQuery);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const valueClass = 'max-w-[28rem] truncate text-sm text-(--nav-label-color)';

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-[832px] px-7 pb-10">
        {/* Memory Status */}
        <SettingsSection title={t('memory.status.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('settings:projectPages.context.memoryStatus')}
              description={
                memoryStatus?.available
                  ? undefined
                  : `${memoryStatus?.reason || t('memory.status.notConfigured')} ${t('memory.status.enableInSettings')}`
              }
            >
              <StatusIndicator state={memoryStatus?.available ? 'success' : 'neutral'}>
                {memoryStatus?.available ? t('memory.status.connected') : t('memory.status.notAvailable')}
              </StatusIndicator>
            </SettingsRow>

            {memoryStatus?.available && (
              <>
                <SettingsRow label={t('memory.info.database')}>
                  <span className={valueClass}>{memoryStatus.database || 'auto_claude_memory'}</span>
                </SettingsRow>
                <SettingsRow label={t('memory.info.path')}>
                  <span className={cn(valueClass, 'font-mono text-[0.8125rem]')}>
                    {memoryStatus.dbPath || '~/.auto-claude/memories'}
                  </span>
                </SettingsRow>
                {memoryStatus.embeddingProvider && (
                  <SettingsRow label={t('memory.info.embedding')}>
                    <span className={valueClass}>{memoryStatus.embeddingProvider}</span>
                  </SettingsRow>
                )}
                {memoryState && (
                  <SettingsRow label={t('memory.info.memories')}>
                    <span className={valueClass}>{memoryState.episodeCount}</span>
                  </SettingsRow>
                )}
                {memoryHealth && recentMemories.length > 0 && (
                  <>
                    <SettingsRow label={t('memory.health.totalMemories')}>
                      <span className={valueClass}>{recentMemories.length}</span>
                    </SettingsRow>
                    <SettingsRow label={t('memory.health.avgConfidence')}>
                      <span className={valueClass}>{memoryHealth.avgConfidence}%</span>
                    </SettingsRow>
                    <SettingsRow label={t('memory.health.verified')}>
                      <span className={valueClass}>{memoryHealth.verifiedPct}%</span>
                    </SettingsRow>
                  </>
                )}
              </>
            )}
          </SettingsRows>
        </SettingsSection>

        {/* Search */}
        <SettingsSection title={t('memory.search.title')}>
          <div className="flex gap-2">
            <Input
              placeholder={t('memory.search.placeholder')}
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label={t('memory.search.title')}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleSearch}
              disabled={searchLoading}
              className="w-8 shrink-0 px-0"
              aria-label={t('memory.search.title')}
            >
              <Search className={cn('h-4 w-4', searchLoading && 'animate-pulse')} strokeWidth={1.75} />
            </Button>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-(--nav-label-color)">
                {t('memory.search.resultsCount', { count: searchResults.length })}
              </p>
              <SettingsRows className="mt-1">
                {searchResults.map((result, idx) => (
                  <div key={idx} className="py-3">
                    <div className="mb-2 flex items-center gap-2 text-sm">
                      <span className="capitalize text-foreground">{result.type.replace('_', ' ')}</span>
                      <span className="text-(--nav-label-color)">
                        {t('settings:projectPages.context.score', { score: result.score.toFixed(2) })}
                      </span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-segment-track px-4 py-3 font-mono text-xs text-muted-foreground">
                      {result.content}
                    </pre>
                  </div>
                ))}
              </SettingsRows>
            </div>
          )}
        </SettingsSection>

        {/* Memory Browser */}
        <SettingsSection title={t('memory.browser.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('settings:projectPages.context.filter')}
              description={t('memory.browser.countOf', {
                filtered: filteredMemories.length,
                total: recentMemories.length
              })}
            >
              <Select value={activeFilter} onValueChange={(value) => setActiveFilter(value as MemoryFilterCategory)}>
                <SelectTrigger aria-label={t('settings:projectPages.context.filter')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memoryFilterCategories.map((category) => {
                    const count = memoryCounts[category.key];
                    return (
                      <SelectItem
                        key={category.key}
                        value={category.key}
                        disabled={count === 0 && category.key !== 'all'}
                      >
                        {t(`memory.filters.${category.key}`, { defaultValue: category.label })}
                        {count > 0 && <span className="ml-1.5 text-(--nav-label-color)">{count}</span>}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </SettingsRow>

            {/* Memory List */}
            {memoriesLoading && (
              <SettingsRow label={<StatusIndicator state="loading">{t('settings:projectPages.context.loadingMemories')}</StatusIndicator>} />
            )}

            {!memoriesLoading && filteredMemories.length === 0 && recentMemories.length === 0 && (
              <p className="py-3 text-sm text-(--nav-label-color)">{t('memory.empty')}</p>
            )}

            {!memoriesLoading && filteredMemories.length === 0 && recentMemories.length > 0 && (
              <SettingsRow label={t('memory.emptyFilter')}>
                <Button variant="outline" size="sm" onClick={() => setActiveFilter('all')}>
                  {t('memory.showAll')}
                </Button>
              </SettingsRow>
            )}

            {filteredMemories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onVerify={onVerify}
                onPin={onPin}
                onDeprecate={onDeprecate}
              />
            ))}
          </SettingsRows>
        </SettingsSection>
      </div>
    </ScrollArea>
  );
}
