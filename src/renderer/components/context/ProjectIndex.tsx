import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useContextStore } from '../../stores/context-store';
import { useRefreshIndex } from './hooks';
import { useEffect, useState } from 'react';
import { loadProjectContext } from '../../stores/context-store';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';

/**
 * The project index row (Analyze/Refresh, plus loading and error), placed in the General
 * page's Auto-Build section.
 */
export function ProjectIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const { projectIndex, indexLoading, indexError } = useContextStore();
  const refreshIndex = useRefreshIndex(projectId);

  // Whether the project has an index, remembered per project so opening the page doesn't load
  // the project context (and start the memory service) again; Analyze/Refresh updates it
  const cacheKey = `project-index:${projectId}`;
  const [cachedHasIndex, setCachedHasIndex] = useState(() => readRefreshCache<boolean>(cacheKey));
  // The shared context store may hold another project's index: only trust it after this page
  // loaded or analyzed this project
  const [fetchedHere, setFetchedHere] = useState(false);
  useEffect(() => {
    const cached = readRefreshCache<boolean>(cacheKey);
    setCachedHasIndex(cached);
    setFetchedHere(false);
    if (cached === undefined) void loadProjectContext(projectId).then(() => setFetchedHere(true));
  }, [cacheKey, projectId]);
  useEffect(() => {
    if (!fetchedHere || indexLoading || indexError) return;
    writeRefreshCache(cacheKey, !!projectIndex);
    setCachedHasIndex(!!projectIndex);
  }, [cacheKey, fetchedHere, projectIndex, indexLoading, indexError]);
  const onRefresh = () => {
    void refreshIndex().then(() => setFetchedHere(true));
  };
  const hasIndex = fetchedHere ? !!projectIndex : !!cachedHasIndex;

  return (
    <>
      <SettingsRow
        label={t('projectPages.context.index')}
        description={
          !indexLoading && !hasIndex && !indexError
            ? t('projectPages.context.noIndex')
            : t('projectPages.context.indexDescription')
        }
      >
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={indexLoading} className="gap-2">
          <RefreshCw className={cn('h-4 w-4', indexLoading && 'animate-spin')} strokeWidth={1.75} />
          {hasIndex ? t('projectPages.context.refresh') : t('projectPages.context.analyze')}
        </Button>
      </SettingsRow>

      {indexError && (
        <SettingsRow
          label={
            <StatusIndicator state="error" tone="foreground">
              {t('projectPages.context.loadFailed')}
            </StatusIndicator>
          }
          description={indexError}
        />
      )}

      {indexLoading && (
        <SettingsRow
          label={<StatusIndicator state="loading">{t('projectPages.context.analyzing')}</StatusIndicator>}
        />
      )}
    </>
  );
}
