import { X, GripVertical, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { Task, TerminalWorktreeConfig } from '../../../shared/types';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { AgentsIcon, TerminalPromptIcon } from '../icons/app-icons';
import { TaskSelector } from './TaskSelector';
import { SessionSelector } from './SessionSelector';
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
}: TerminalHeaderProps) {
  const { t } = useTranslation(['terminal', 'common']);
  // Tasks an agent window can pick: those with a Claude Code session to resume (not archived),
  // and backlog tasks (their description is sent to the running session)
  const selectableTasks = tasks.filter(
    (task) => (!!task.claudeRun?.sessionId && !task.metadata?.archivedAt) || task.status === 'backlog'
  );

  return (
    <div className="electron-no-drag flex h-11 items-center justify-between border-b border-border px-2">
      <div className="flex items-center gap-2">
        {/* Drag handle - always shown, dimmed until pointed at */}
        {dragHandleListeners && (
          <div
            {...dragHandleListeners}
            className={cn(
              'flex items-center justify-center',
              'w-4 h-8 -ml-1',
              'opacity-60 hover:opacity-100 transition-opacity',
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
            <AgentsIcon className="h-4 w-4 text-primary" />
          ) : (
            <TerminalPromptIcon className="h-4 w-4 text-primary" />
          )}
        </span>
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
        {/* Agent windows: the Claude Code session (new, or one /resume would offer) */}
        {isCLIMode && (
          <SessionSelector
            terminalId={terminalId}
            labelClassName={terminalCount >= 6 ? 'max-w-20' : terminalCount >= 4 ? 'max-w-28' : 'max-w-40'}
          />
        )}
        {isCLIMode && (
          <TaskSelector
            terminalId={terminalId}
            tasks={selectableTasks}
            associatedTask={associatedTask}
            onTaskSelect={onTaskSelect}
            onClearTask={onClearTask}
            onNewTaskClick={onNewTaskClick}
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        {/* Expand/collapse button */}
        {onToggleExpand && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-nav-hover"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            title={isExpanded ? t('terminal:expand.collapse') : t('terminal:expand.expand')}
          >
            {isExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-nav-hover"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('common:buttons.close')}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
