import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { StatusIndicator } from '../settings/common/StatusIndicator';
import { ServiceCard } from './ServiceCard';
import type { ProjectIndex } from '../../../shared/types';

interface ProjectIndexTabProps {
  projectIndex: ProjectIndex | null;
  indexLoading: boolean;
  indexError: string | null;
  onRefresh: () => void;
}

/** A row with a label on the left and a muted value on the right */
function ValueRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <SettingsRow label={label}>
      <span className={cn('max-w-[28rem] truncate text-sm text-(--nav-label-color)', mono && 'font-mono text-[0.8125rem]')}>
        {value}
      </span>
    </SettingsRow>
  );
}

export function ProjectIndexTab({
  projectIndex,
  indexLoading,
  indexError,
  onRefresh
}: ProjectIndexTabProps) {
  const { t } = useTranslation('settings');
  const serviceCount = projectIndex ? Object.keys(projectIndex.services).length : 0;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-[832px] px-7 pb-10">
        <SettingsSection title={t('projectPages.context.structureTitle')}>
          <SettingsRows>
            <SettingsRow
              label={t('projectPages.context.index')}
              description={
                !indexLoading && !projectIndex && !indexError
                  ? t('projectPages.context.noIndex')
                  : t('projectPages.context.indexDescription')
              }
            >
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={indexLoading} className="gap-2">
                <RefreshCw className={cn('h-4 w-4', indexLoading && 'animate-spin')} strokeWidth={1.75} />
                {projectIndex ? t('projectPages.context.refresh') : t('projectPages.context.analyze')}
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

            {indexLoading && !projectIndex && (
              <SettingsRow
                label={<StatusIndicator state="loading">{t('projectPages.context.analyzing')}</StatusIndicator>}
              />
            )}

            {projectIndex && (
              <>
                <ValueRow
                  label={t('projectPages.context.projectType')}
                  value={<span className="capitalize">{projectIndex.project_type}</span>}
                />
                <ValueRow label={t('projectPages.context.services')} value={String(serviceCount)} />
                <ValueRow label={t('projectPages.context.root')} value={projectIndex.project_root} mono />
              </>
            )}
          </SettingsRows>
        </SettingsSection>

        {projectIndex && serviceCount > 0 && (
          <SettingsSection title={t('projectPages.context.services')}>
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(projectIndex.services).map(([name, service]) => (
                <ServiceCard key={name} name={name} service={service} />
              ))}
            </div>
          </SettingsSection>
        )}

        {projectIndex && Object.keys(projectIndex.infrastructure).length > 0 && (
          <SettingsSection title={t('projectPages.context.infrastructure')}>
            <SettingsRows>
              {projectIndex.infrastructure.docker_compose && (
                <ValueRow label="Docker Compose" value={projectIndex.infrastructure.docker_compose} mono />
              )}
              {projectIndex.infrastructure.ci && <ValueRow label="CI/CD" value={projectIndex.infrastructure.ci} />}
              {projectIndex.infrastructure.deployment && (
                <ValueRow label={t('projectPages.context.deployment')} value={projectIndex.infrastructure.deployment} />
              )}
              {projectIndex.infrastructure.docker_services &&
                projectIndex.infrastructure.docker_services.length > 0 && (
                  <SettingsRow label={t('projectPages.context.dockerServices')}>
                    <div className="flex max-w-[28rem] flex-wrap justify-end gap-1">
                      {projectIndex.infrastructure.docker_services.map((svc) => (
                        <Badge key={svc} variant="secondary" className="text-xs font-normal">
                          {svc}
                        </Badge>
                      ))}
                    </div>
                  </SettingsRow>
                )}
            </SettingsRows>
          </SettingsSection>
        )}

        {projectIndex && Object.keys(projectIndex.conventions).length > 0 && (
          <SettingsSection title={t('projectPages.context.conventions')}>
            <SettingsRows>
              {projectIndex.conventions.python_linting && (
                <ValueRow label={t('projectPages.context.pythonLinting')} value={projectIndex.conventions.python_linting} />
              )}
              {projectIndex.conventions.js_linting && (
                <ValueRow label={t('projectPages.context.jsLinting')} value={projectIndex.conventions.js_linting} />
              )}
              {projectIndex.conventions.formatting && (
                <ValueRow label={t('projectPages.context.formatting')} value={projectIndex.conventions.formatting} />
              )}
              {projectIndex.conventions.git_hooks && (
                <ValueRow label={t('projectPages.context.gitHooks')} value={projectIndex.conventions.git_hooks} />
              )}
              {projectIndex.conventions.typescript && (
                <SettingsRow label="TypeScript">
                  <StatusIndicator state="success">{t('projectPages.context.enabled')}</StatusIndicator>
                </SettingsRow>
              )}
            </SettingsRows>
          </SettingsSection>
        )}
      </div>
    </ScrollArea>
  );
}
