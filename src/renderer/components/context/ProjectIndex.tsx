import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { SettingsRow } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { useContextStore } from '../../stores/context-store';
import { useProjectContext, useRefreshIndex } from './hooks';

/**
 * The project index row (Analyze/Refresh, plus loading and error), placed in the General
 * page's Auto-Build section. Loads the index for the project.
 */
export function ProjectIndexRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation('settings');
  const { projectIndex, indexLoading, indexError } = useContextStore();
  useProjectContext(projectId);
  const onRefresh = useRefreshIndex(projectId);
  const hasIndex = !!projectIndex;

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
