import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { MemoryCard } from './MemoryCard';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { memoryFilterCategories, type MemoryFilterCategory } from './constants';

/** Pause in typing before the memory search runs */
const SEARCH_DELAY_MS = 1000;
import type { RendererMemory } from '../../../shared/types';

interface MemoriesTabProps {
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

  // Search once typing has stopped for a second
  const searchRef = useRef(handleSearch);
  searchRef.current = handleSearch;
  useEffect(() => {
    if (!localSearchQuery.trim()) return;
    const timer = setTimeout(() => searchRef.current(), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [localSearchQuery]);

  return (
    <>
        {/* Memory browser: search (runs after a pause in typing) with the type filter, then the list */}
        <SettingsSection title={t('memory.browser.title')}>
          <div className="flex gap-2">
            <Input
              placeholder={t('memory.search.placeholder')}
              value={localSearchQuery}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label={t('memory.search.title')}
            />
            <Select value={activeFilter} onValueChange={(value) => setActiveFilter(value as MemoryFilterCategory)}>
              <SelectTrigger className="w-auto shrink-0 gap-2" aria-label={t('settings:projectPages.context.filter')}>
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
          </div>

          {searchLoading && (
            <p className="mt-3 text-sm text-(--nav-label-color)">{t('memory.search.searching')}</p>
          )}

          {/* Search Results */}
          {!searchLoading && searchResults.length > 0 && (
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

          <SettingsRows className="mt-2">
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
    </>
  );
}
