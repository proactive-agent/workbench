import { useState, useMemo } from 'react';
import {
  Terminal,
  Loader2,
  Pencil,
  FileCode,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
  FolderSearch,
  Wrench,
  Info,
  Clock,
  Pause
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settings-store';
import type { Task, TaskLogs, TaskLogPhase, TaskPhaseLog, TaskLogEntry } from '../../../shared/types';

// Neutral chip for tool activity (no per-tool colors)
const TOOL_CHIP_CLASS = 'text-muted-foreground bg-segment-track';

interface TaskLogsProps {
  task: Task;
  phaseLogs: TaskLogs | null;
  isLoadingLogs: boolean;
  expandedPhases: Set<TaskLogPhase>;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
  logsContainerRef: React.RefObject<HTMLDivElement | null>;
  onLogsScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  onTogglePhase: (phase: TaskLogPhase) => void;
}


export function TaskLogs({
  task,
  phaseLogs,
  isLoadingLogs,
  expandedPhases,
  logsEndRef,
  logsContainerRef,
  onLogsScroll,
  onTogglePhase
}: TaskLogsProps) {
  const { t } = useTranslation(['tasks']);
  return (
    <div
      ref={logsContainerRef}
      className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
      onScroll={onLogsScroll}
    >
      <div className="p-4 space-y-2">
        {isLoadingLogs ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : phaseLogs ? (
          <>
            {/* Phase-based collapsible logs */}
            {(['planning', 'coding', 'validation'] as TaskLogPhase[]).map((phase) => (
              <PhaseLogSection
                key={phase}
                phase={phase}
                phaseLog={phaseLogs.phases[phase]}
                isExpanded={expandedPhases.has(phase)}
                onToggle={() => onTogglePhase(phase)}
                isTaskSettled={task.status === 'human_review' || task.status === 'done' || task.status === 'pr_created' || task.status === 'error'}
              />
            ))}
            <div ref={logsEndRef} />
          </>
        ) : task.logs && task.logs.length > 0 ? (
          // Fallback to legacy raw logs if no phase logs exist
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {task.logs.join('\n')}
            <div ref={logsEndRef} />
          </pre>
        ) : (
          <div className="text-center text-sm text-muted-foreground py-8">
            <Terminal className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{t('tasks:logs.empty')}</p>
            <p className="text-xs mt-1">{t('tasks:logs.emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Phase Log Section Component
interface PhaseLogSectionProps {
  phase: TaskLogPhase;
  phaseLog: TaskPhaseLog | null;
  isExpanded: boolean;
  onToggle: () => void;
  isTaskSettled?: boolean;
}

// Same status icons as the subtasks list: green/red only for success/failure
function getPhaseStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-[var(--error)]" />;
    case 'active':
      return <Clock className="h-4 w-4 text-muted-foreground animate-pulse" />;
    default:
      return <Pause className="h-4 w-4 text-muted-foreground" />;
  }
}

function PhaseLogSection({ phase, phaseLog, isExpanded, onToggle, isTaskSettled }: PhaseLogSectionProps) {
  const { t } = useTranslation(['tasks']);
  const logOrder = useSettingsStore(s => s.settings.logOrder);
  // If the task is in a settled state (human_review, done, etc.), any "active" phase
  // is actually completed — the log writer may have missed the endPhase() call.
  let status = phaseLog?.status || 'pending';
  if (status === 'active' && isTaskSettled) {
    status = 'completed';
  }
  const hasEntries = (phaseLog?.entries.length || 0) > 0;

  // Memoize sorted entries to avoid re-calculating on every render
  // Entries are naturally in chronological order (oldest first from append())
  const displayedEntries = useMemo(() => {
    const entries = phaseLog?.entries || [];
    return logOrder === 'reverse-chronological' ? [...entries].reverse() : entries;
  }, [phaseLog?.entries, logOrder]);

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-xl border border-border p-3 text-left transition-colors hover:bg-nav-hover"
        >
          <span className="shrink-0">{getPhaseStatusIcon(status)}</span>
          <span className="text-sm text-foreground">{t(`tasks:logs.phases.${phase}`)}</span>
          {hasEntries && (
            <span className="text-xs text-(--nav-label-color)">
              {t('tasks:logs.entries', { count: phaseLog?.entries.length ?? 0 })}
            </span>
          )}
          <ChevronRight
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-6 border-l-2 border-border pl-4 py-2 space-y-1">
          {!hasEntries ? (
            <p className="text-xs text-muted-foreground">{t('tasks:logs.empty')}</p>
          ) : (
            displayedEntries.map((entry) => (
              <LogEntry key={`${entry.timestamp}-${entry.type}-${entry.content}`} entry={entry} />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Log Entry Component
interface LogEntryProps {
  entry: TaskLogEntry;
}

function LogEntry({ entry }: LogEntryProps) {
  const { t } = useTranslation(['tasks']);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetail = Boolean(entry.detail);

  const getToolInfo = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return { icon: FileText, label: t('tasks:logs.tools.reading'), color: TOOL_CHIP_CLASS };
      case 'Glob':
        return { icon: FolderSearch, label: t('tasks:logs.tools.searchingFiles'), color: TOOL_CHIP_CLASS };
      case 'Grep':
        return { icon: Search, label: t('tasks:logs.tools.searchingCode'), color: TOOL_CHIP_CLASS };
      case 'Edit':
        return { icon: Pencil, label: t('tasks:logs.tools.editing'), color: TOOL_CHIP_CLASS };
      case 'Write':
        return { icon: FileCode, label: t('tasks:logs.tools.writing'), color: TOOL_CHIP_CLASS };
      case 'Bash':
        return { icon: Terminal, label: t('tasks:logs.tools.running'), color: TOOL_CHIP_CLASS };
      default:
        return { icon: Wrench, label: toolName, color: TOOL_CHIP_CLASS };
    }
  };

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      // Use system locale for date and time formatting
      return date.toLocaleString();
    } catch {
      return '';
    }
  };

  const SubphaseBadge = () => {
    if (!entry.subphase) return null;
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1 text-muted-foreground border-muted-foreground/30">
        {entry.subphase}
      </Badge>
    );
  };

  if (entry.type === 'tool_start' && entry.tool_name) {
    const { icon: Icon, label, color } = getToolInfo(entry.tool_name);
    return (
      <div className="flex flex-col">
        <div className={cn('inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs', color)}>
          <Icon className="h-3 w-3 animate-pulse" />
          <span className="font-medium">{label}</span>
          {entry.tool_input && (
            <span className="text-muted-foreground truncate max-w-[500px]" title={entry.tool_input}>
              {entry.tool_input}
            </span>
          )}
          <SubphaseBadge />
        </div>
      </div>
    );
  }

  if (entry.type === 'tool_end' && entry.tool_name) {
    const { icon: Icon, color } = getToolInfo(entry.tool_name);
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <div className={cn('inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs', color, 'opacity-60')}>
            <Icon className="h-3 w-3" />
            <CheckCircle2 className="h-3 w-3 text-success" />
            <span className="text-muted-foreground">{t('tasks:logs.done')}</span>
          </div>
          {hasDetail && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={cn(
                'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded',
                'text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors',
                isExpanded && 'bg-secondary/50'
              )}
            >
              {isExpanded ? (
                <>
                  <ChevronDown className="h-2.5 w-2.5" />
                  <span>{t('tasks:logs.hideOutput')}</span>
                </>
              ) : (
                <>
                  <ChevronRight className="h-2.5 w-2.5" />
                  <span>{t('tasks:logs.showOutput')}</span>
                </>
              )}
            </button>
          )}
        </div>
        {hasDetail && isExpanded && (
          <div className="mt-1.5 ml-4 p-2 rounded-lg border border-border overflow-x-auto">
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
              {entry.detail}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="flex flex-col">
        <div className="flex items-start gap-2 text-xs text-destructive px-2 py-1">
          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="break-words flex-1">{entry.content}</span>
          <SubphaseBadge />
          {hasDetail && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={cn(
                'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0',
                'text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors',
                isExpanded && 'bg-secondary/50'
              )}
            >
              {isExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
            </button>
          )}
        </div>
        {hasDetail && isExpanded && (
          <div className="mt-1.5 ml-4 p-2 rounded-lg border border-border overflow-x-auto">
            <pre className="text-[10px] text-destructive/80 whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
              {entry.detail}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (entry.type === 'success') {
    return (
      <div className="flex items-start gap-2 text-xs text-foreground px-2 py-1">
        <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-success" />
        <span className="break-words flex-1">{entry.content}</span>
        <SubphaseBadge />
      </div>
    );
  }

  if (entry.type === 'info') {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground px-2 py-1">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="break-words flex-1">{entry.content}</span>
        <SubphaseBadge />
      </div>
    );
  }

  // Default text entry
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 text-xs text-muted-foreground py-0.5">
        <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
          {formatTime(entry.timestamp)}
        </span>
        <span className="break-words whitespace-pre-wrap flex-1">{entry.content}</span>
        <SubphaseBadge />
        {hasDetail && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0',
              'text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors',
              isExpanded && 'bg-secondary/50'
            )}
          >
            {isExpanded ? (
              <>
                <ChevronDown className="h-2.5 w-2.5" />
                <span>{t('tasks:logs.less')}</span>
              </>
            ) : (
              <>
                <ChevronRight className="h-2.5 w-2.5" />
                <span>{t('tasks:logs.more')}</span>
              </>
            )}
          </button>
        )}
      </div>
      {hasDetail && isExpanded && (
        <div className="mt-1.5 ml-12 p-2 rounded-lg border border-border overflow-x-auto">
          <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
            {entry.detail}
          </pre>
        </div>
      )}
    </div>
  );
}
