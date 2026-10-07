import { useState, useRef, useLayoutEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Target,
  Bug,
  Wrench,
  FileCode,
  Shield,
  Gauge,
  Palette,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { cn, formatRelativeTime } from '../../lib/utils';
import {
  TASK_CATEGORY_LABELS,
  TASK_COMPLEXITY_LABELS,
  TASK_IMPACT_LABELS,
  TASK_PRIORITY_LABELS,
  JSON_ERROR_PREFIX
} from '../../../shared/constants';
import type { Task, TaskCategory } from '../../../shared/types';

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Target> = {
  feature: Target,
  bug_fix: Bug,
  refactoring: Wrench,
  documentation: FileCode,
  security: Shield,
  performance: Gauge,
  ui_ux: Palette,
  infrastructure: Wrench,
  testing: FileCode
};

interface TaskMetadataProps {
  task: Task;
}

// Height threshold for collapsing long descriptions (~8 lines)
const COLLAPSED_HEIGHT = 200;

export function TaskMetadata({ task }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  // Handle JSON error description with i18n
  const displayDescription = (() => {
    if (!task.description) return null;
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      return t('errors:task.jsonError.description', { error: errorMessage });
    }
    return task.description;
  })();

  // Detect if content overflows the collapsed height
  // Re-check when description changes (content height depends on rendered description)
  // Reset expand state when switching tasks to avoid stale expanded state
  useLayoutEffect(() => {
    setIsExpanded(false);
    const element = contentRef.current;
    if (element) {
      const hasContentOverflow = element.scrollHeight > COLLAPSED_HEIGHT;
      setHasOverflow(hasContentOverflow);
    }
  }, [task.id, task.description]);

  const classification = task.metadata
    ? [
        task.metadata.category && {
          key: 'category',
          icon: CategoryIcon[task.metadata.category],
          label: TASK_CATEGORY_LABELS[task.metadata.category]
        },
        task.metadata.priority && { key: 'priority', label: TASK_PRIORITY_LABELS[task.metadata.priority] },
        task.metadata.complexity && { key: 'complexity', label: TASK_COMPLEXITY_LABELS[task.metadata.complexity] },
        task.metadata.impact && { key: 'impact', label: TASK_IMPACT_LABELS[task.metadata.impact] },
        task.metadata.securitySeverity && {
          key: 'severity',
          icon: Shield,
          label: `${task.metadata.securitySeverity} ${t('tasks:metadata.severity')}`
        },
        task.metadata.sourceType && { key: 'source', label: task.metadata.sourceType }
      ].filter(Boolean) as { key: string; icon?: typeof Target; label: string }[]
    : [];

  const metaItems: { key: string; icon?: typeof Target; label: string }[] = [
    ...classification,
    { key: 'created', label: t('tasks:metadata.created', { time: formatRelativeTime(task.createdAt) }) },
    { key: 'updated', label: t('tasks:metadata.updated', { time: formatRelativeTime(task.updatedAt) }) }
  ];

  const hasDetails = !!task.metadata && !!(
    task.metadata.rationale ||
    task.metadata.problemSolved ||
    task.metadata.targetAudience ||
    (task.metadata.dependencies && task.metadata.dependencies.length > 0) ||
    task.metadata.prUrl ||
    (task.metadata.acceptanceCriteria && task.metadata.acceptanceCriteria.length > 0) ||
    (task.metadata.affectedFiles && task.metadata.affectedFiles.length > 0)
  );

  return (
    <div className="space-y-4">
      {/* Classification + timeline as one muted line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--nav-label-color)">
        {metaItems.map((item, idx) => {
          const Icon = item.icon;
          return (
            <span key={item.key} className="flex items-center gap-2">
              {idx > 0 && <span aria-hidden="true">·</span>}
              <span className="flex items-center gap-1">
                {Icon && <Icon className="h-3 w-3" strokeWidth={1.75} />}
                {item.label}
              </span>
            </span>
          );
        })}
      </div>

      {/* Description - primary content in the claude info box */}
      {displayDescription && (
        <div className="max-w-full overflow-hidden rounded-xl bg-segment-track px-4 py-3">
          <div
            ref={contentRef}
            id={contentId}
            className={cn(
              'prose prose-sm dark:prose-invert max-w-none overflow-hidden prose-p:text-foreground/90 prose-p:leading-relaxed prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground/90 prose-ul:my-2 prose-li:my-0.5 prose-a:break-all prose-pre:overflow-x-auto prose-img:max-w-full [&_img]:!max-w-full [&_img]:h-auto [&_code]:break-all [&_code]:whitespace-pre-wrap [&_*]:max-w-full',
              // Fade the last lines out while collapsed
              !isExpanded && hasOverflow && 'max-h-[200px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
            )}
            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {displayDescription}
            </ReactMarkdown>
          </div>

          {/* Expand/Collapse button */}
          {hasOverflow && (
            <div className="mt-2 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-muted-foreground hover:text-foreground"
                aria-expanded={isExpanded}
                aria-controls={contentId}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="mr-1 h-4 w-4" aria-hidden="true" />
                    {t('tasks:metadata.showLess')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />
                    {t('tasks:metadata.showMore')}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Secondary details as plain rows */}
      {task.metadata && hasDetails && (
        <SettingsRows>
          {task.metadata.rationale && (
            <SettingsRow label={t('tasks:metadata.rationale')} description={task.metadata.rationale} />
          )}

          {task.metadata.problemSolved && (
            <SettingsRow label={t('tasks:metadata.problemSolved')} description={task.metadata.problemSolved} />
          )}

          {task.metadata.targetAudience && (
            <SettingsRow label={t('tasks:metadata.targetAudience')} description={task.metadata.targetAudience} />
          )}

          {task.metadata.dependencies && task.metadata.dependencies.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.dependencies')}
              description={
                <ul className="list-inside list-disc space-y-0.5">
                  {task.metadata.dependencies.map((dep, idx) => (
                    <li key={idx}>{dep}</li>
                  ))}
                </ul>
              }
            />
          )}

          {task.metadata.prUrl && (
            <SettingsRow
              label={t('tasks:metadata.pullRequest')}
              description={
                <button
                  type="button"
                  onClick={() => {
                    if (task.metadata?.prUrl) {
                      window.electronAPI.openExternal(task.metadata.prUrl);
                    }
                  }}
                  className="flex cursor-pointer items-center gap-1.5 break-all border-none bg-transparent p-0 text-left text-foreground hover:underline"
                >
                  {task.metadata.prUrl}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                </button>
              }
            />
          )}

          {task.metadata.acceptanceCriteria && task.metadata.acceptanceCriteria.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.acceptanceCriteria')}
              description={
                <ul className="list-inside list-disc space-y-0.5">
                  {task.metadata.acceptanceCriteria.map((criteria, idx) => (
                    <li key={idx}>{criteria}</li>
                  ))}
                </ul>
              }
            />
          )}

          {task.metadata.affectedFiles && task.metadata.affectedFiles.length > 0 && (
            <SettingsRow
              label={t('tasks:metadata.affectedFiles')}
              description={
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {task.metadata.affectedFiles.map((file, idx) => (
                    <Tooltip key={idx}>
                      <TooltipTrigger asChild>
                        <span className="cursor-help font-mono text-xs">{file.split('/').pop()}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-xs">
                        {file}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              }
            />
          )}
        </SettingsRows>
      )}
    </div>
  );
}
