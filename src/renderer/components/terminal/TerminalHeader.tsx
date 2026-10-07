import { X, GripVertical, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task, TerminalWorktreeConfig } from '../../../shared/types';
import { useTerminalStore } from '../../stores/terminal-store';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { AgentsIcon, TerminalPromptIcon } from '../icons/app-icons';
import { TaskSelector } from './TaskSelector';
import { WorktreeSelector } from './WorktreeSelector';

interface TerminalHeaderProps {
  terminalId: string;
  isCLIMode: boolean;
  tasks: Task[];
  associatedTask?: Task;
  onClose: () => void;
  onTaskSelect: (taskId: string) => void;
  onClearTask: () => void;
  onNewTaskClick?: () => void;
  terminalCount?: number;
  /** Worktree configuration if terminal is associated with a worktree */
  worktreeConfig?: TerminalWorktreeConfig;
  /** Project path for worktree operations */
  projectPath?: string;
  /** Callback to open worktree creation dialog */
  onCreateWorktree?: () => void;
  /** Callback when an existing worktree is selected */
  onSelectWorktree?: (config: TerminalWorktreeConfig) => void;
  /** Callback to open worktree in IDE */
  /** Drag handle listeners for terminal reordering */
  dragHandleListeners?: SyntheticListenerMap;
  /** Whether the terminal is expanded to full view */
  isExpanded?: boolean;
  /** Callback to toggle expanded state */
  onToggleExpand?: () => void;
  /** Whether this terminal has a pending Claude resume (deferred until tab activated) */
  pendingCLIResume?: boolean;
}

export function TerminalHeader({
  terminalId,
  isCLIMode,
  tasks,
  associatedTask,
  onClose,
  onTaskSelect,
  onClearTask,
  onNewTaskClick,
  terminalCount = 1,
  worktreeConfig,
  projectPath,
  onCreateWorktree,
  onSelectWorktree,
  dragHandleListeners,
  isExpanded,
  onToggleExpand,
  pendingCLIResume,
}: TerminalHeaderProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const backlogTasks = tasks.filter((t) => t.status === 'backlog');

  // Check if 2+ terminals have pending Claude resume
  // Use a derived selector returning a primitive to avoid re-renders on unrelated terminal changes
  const pendingResumeCount = useTerminalStore(
    (state) => state.terminals.filter((t) => t.pendingCLIResume === true).length
  );
  const showResumeAllButton = pendingResumeCount >= 2;

  return (
    <div className="electron-no-drag group/header flex h-9 items-center justify-between border-b border-border px-2">
      <div className="flex items-center gap-2">
        {/* Drag handle - visible on hover */}
        {dragHandleListeners && (
          <div
            {...dragHandleListeners}
            className={cn(
              'flex items-center justify-center',
              'w-4 h-6 -ml-1',
              'opacity-0 group-hover/header:opacity-60',
              'hover:opacity-100 transition-opacity',
              'cursor-grab active:cursor-grabbing',
              'text-muted-foreground hover:text-foreground'
            )}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </div>
        )}
        {/* Window type: agent (Claude Code) or plain terminal */}
        <span className="flex shrink-0 items-center" title={isCLIMode ? t('terminal:header.agent') : t('terminal:header.terminal')}>
          {isCLIMode ? (
            <AgentsIcon className="h-3.5 w-3.5 text-primary" />
          ) : (
            <TerminalPromptIcon className="h-3.5 w-3.5 text-primary" />
          )}
        </span>
        {pendingCLIResume && (
          <span
            className="flex items-center gap-1 text-[10px] font-medium text-cyan-500 bg-cyan-500/10 px-1.5 py-0.5 rounded animate-pulse"
            title={t('terminal:resume.pendingTooltip')}
          >
            <RotateCcw className="h-2.5 w-2.5" />
            {terminalCount < 4 && <span>{t('terminal:resume.pending')}</span>}
          </span>
        )}
        {/* Worktree selector - labelled with the active worktree, which can be switched */}
        {projectPath && onCreateWorktree && onSelectWorktree && (
          <WorktreeSelector
            terminalId={terminalId}
            projectPath={projectPath}
            currentWorktree={worktreeConfig}
            onCreateWorktree={onCreateWorktree}
            onSelectWorktree={onSelectWorktree}
            labelClassName={terminalCount >= 6 ? 'max-w-20' : terminalCount >= 4 ? 'max-w-28' : 'max-w-40'}
          />
        )}
        {isCLIMode && (
          <TaskSelector
            terminalId={terminalId}
            backlogTasks={backlogTasks}
            associatedTask={associatedTask}
            onTaskSelect={onTaskSelect}
            onClearTask={onClearTask}
            onNewTaskClick={onNewTaskClick}
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        {/* Resume All button - shown when 2+ terminals have pending resume */}
        {showResumeAllButton && (
          <Button
            variant="ghost"
            size={terminalCount >= 4 ? 'icon' : 'sm'}
            className={cn(
              'h-6 hover:bg-cyan-500/10 hover:text-cyan-500 animate-pulse',
              terminalCount >= 4 ? 'w-6' : 'px-2 text-xs gap-1',
              'text-cyan-500 bg-cyan-500/10'
            )}
            onClick={(e) => {
              e.stopPropagation();
              useTerminalStore.getState().resumeAllPendingClaude();
            }}
            title={t('terminal:resume.resumeAllSessions')}
          >
            <RotateCcw className="h-3 w-3" />
            {terminalCount < 4 && <span>{t('terminal:resume.resumeAllSessions')}</span>}
          </Button>
        )}
        {/* Expand/collapse button */}
        {onToggleExpand && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-nav-hover"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            title={isExpanded ? t('terminal:expand.collapse') : t('terminal:expand.expand')}
          >
            {isExpanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 hover:bg-nav-hover"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('common:close')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
