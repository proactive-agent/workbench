import { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useViewState } from '../contexts/ViewStateContext';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { Plus, Inbox, Loader2, Eye, CheckCircle2, Archive, RefreshCw, ListPlus } from 'lucide-react';
import { SettingsIcon as Settings } from './icons/app-icons';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { TaskCard } from './TaskCard';
import { SortableTaskCard } from './SortableTaskCard';
import { TASK_STATUS_COLUMNS, TASK_STATUS_LABELS } from '../../shared/constants';
import { cn } from '../lib/utils';
import { persistTaskStatus, forceCompleteTask, archiveTasks, useTaskStore, isQueueAtCapacity } from '../stores/task-store';
import { resolveMaxParallelTasks } from '../../shared/constants/task';
import { isTaskOnRateLimitHold } from '../../shared/utils/rate-limit-hold';
import { useProjectStore } from '../stores/project-store';
import { useSettingsStore } from '../stores/settings-store';
import { useToast } from '../hooks/use-toast';
import { WorktreeCleanupDialog } from './WorktreeCleanupDialog';
import type { Task, TaskStatus, TaskOrderState } from '../../shared/types';

// Type guard for valid drop column targets - preserves literal type from TASK_STATUS_COLUMNS
const VALID_DROP_COLUMNS = new Set<string>(TASK_STATUS_COLUMNS);
function isValidDropColumn(id: string): id is typeof TASK_STATUS_COLUMNS[number] {
  return VALID_DROP_COLUMNS.has(id);
}

/**
 * Get the visual column for a task status.
 * pr_created tasks are displayed in the 'done' column, so we map them accordingly.
 * error tasks are displayed in the 'human_review' column (errors need human attention).
 * This is used to compare visual positions during drag-and-drop operations.
 */
function getVisualColumn(status: TaskStatus): typeof TASK_STATUS_COLUMNS[number] {
  if (status === 'pr_created') return 'done';
  if (status === 'error') return 'human_review';
  return status;
}

interface KanbanBoardProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onNewTaskClick?: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

interface DroppableColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, newStatus: TaskStatus) => unknown;
  isOver: boolean;
  onAddClick?: () => void;
  onArchiveAll?: () => void;
  onQueueAll?: () => void;
  maxParallelTasks?: number;
  archivedCount?: number;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}

/**
 * Compare two tasks arrays for meaningful changes.
 * Returns true if tasks are equivalent (should skip re-render).
 */
function tasksAreEquivalent(prevTasks: Task[], nextTasks: Task[]): boolean {
  if (prevTasks.length !== nextTasks.length) return false;
  if (prevTasks === nextTasks) return true;

  // Compare by ID and fields that affect rendering
  for (let i = 0; i < prevTasks.length; i++) {
    const prev = prevTasks[i];
    const next = nextTasks[i];
    if (
      prev.id !== next.id ||
      prev.status !== next.status ||
      prev.executionProgress?.phase !== next.executionProgress?.phase ||
      prev.updatedAt !== next.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Custom comparator for DroppableColumn memo.
 */
function droppableColumnPropsAreEqual(
  prevProps: DroppableColumnProps,
  nextProps: DroppableColumnProps
): boolean {
  // Quick checks first
  if (prevProps.status !== nextProps.status) return false;
  if (prevProps.isOver !== nextProps.isOver) return false;
  if (prevProps.onTaskClick !== nextProps.onTaskClick) return false;
  if (prevProps.onStatusChange !== nextProps.onStatusChange) return false;
  if (prevProps.onAddClick !== nextProps.onAddClick) return false;
  if (prevProps.onArchiveAll !== nextProps.onArchiveAll) return false;
  if (prevProps.onQueueAll !== nextProps.onQueueAll) return false;
  if (prevProps.maxParallelTasks !== nextProps.maxParallelTasks) return false;
  if (prevProps.archivedCount !== nextProps.archivedCount) return false;
  if (prevProps.showArchived !== nextProps.showArchived) return false;
  if (prevProps.onToggleArchived !== nextProps.onToggleArchived) return false;

  // Deep compare tasks
  const tasksEqual = tasksAreEquivalent(prevProps.tasks, nextProps.tasks);

  // Only log when re-rendering (reduces noise)
  if (window.DEBUG && !tasksEqual) {
    console.log(`[DroppableColumn] Re-render: ${nextProps.status} column (${nextProps.tasks.length} tasks)`);
  }

  return tasksEqual;
}

// Empty state content for each column
const getEmptyStateContent = (status: TaskStatus, t: (key: string) => string): { icon: React.ReactNode; message: string; subtext?: string } => {
  switch (status) {
    case 'backlog':
      return {
        icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyBacklog'),
        subtext: t('kanban.emptyBacklogHint')
      };
    case 'queue':
      return {
        icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyQueue'),
        subtext: t('kanban.emptyQueueHint')
      };
    case 'in_progress':
      return {
        icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyInProgress'),
        subtext: t('kanban.emptyInProgressHint')
      };
    case 'ai_review':
      return {
        icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyAiReview'),
        subtext: t('kanban.emptyAiReviewHint')
      };
    case 'human_review':
      return {
        icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyHumanReview'),
        subtext: t('kanban.emptyHumanReviewHint')
      };
    case 'done':
      return {
        icon: <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyDone'),
        subtext: t('kanban.emptyDoneHint')
      };
    default:
      return {
        icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
        message: t('kanban.emptyDefault')
      };
  }
};

const DroppableColumn = memo(function DroppableColumn({ status, tasks, onTaskClick, onStatusChange, isOver, onAddClick, onArchiveAll, onQueueAll, maxParallelTasks, archivedCount, showArchived, onToggleArchived }: DroppableColumnProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { setNodeRef } = useDroppable({
    id: status
  });

  // Memoize taskIds to prevent SortableContext from re-rendering unnecessarily
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  // Create stable onClick handlers for each task to prevent unnecessary re-renders
  const onClickHandlers = useMemo(() => {
    const handlers = new Map<string, () => void>();
    tasks.forEach((task) => {
      handlers.set(task.id, () => onTaskClick(task));
    });
    return handlers;
  }, [tasks, onTaskClick]);

  // Create stable onStatusChange handlers for each task
  const onStatusChangeHandlers = useMemo(() => {
    const handlers = new Map<string, (newStatus: TaskStatus) => unknown>();
    tasks.forEach((task) => {
      handlers.set(task.id, (newStatus: TaskStatus) => onStatusChange(task.id, newStatus));
    });
    return handlers;
  }, [tasks, onStatusChange]);

  // Memoize task card elements to prevent recreation on every render
  const taskCards = useMemo(() => {
    if (tasks.length === 0) return null;
    return tasks.map((task) => (
      <SortableTaskCard
        key={task.id}
        task={task}
        onClick={onClickHandlers.get(task.id)!}
        onStatusChange={onStatusChangeHandlers.get(task.id)}
      />
    ));
  }, [tasks, onClickHandlers, onStatusChangeHandlers]);

  const getColumnBorderColor = (): string => {
    switch (status) {
      case 'backlog':
        return 'column-backlog';
      case 'queue':
        return 'column-queue';
      case 'in_progress':
        return 'column-in-progress';
      case 'ai_review':
        return 'column-ai-review';
      case 'human_review':
        return 'column-human-review';
      case 'done':
        return 'column-done';
      default:
        return 'border-t-muted-foreground/30';
    }
  };

  const emptyState = getEmptyStateContent(status, t);

  return (
    <div className="kanban-compact relative flex min-w-[250px] flex-1 basis-0">
      <div
        ref={setNodeRef}
        className={cn(
          'flex flex-1 flex-col rounded-xl border border-border [.dark_&]:border-white/5 bg-(image:--column-bg) backdrop-blur-sm transition-all duration-200',
          getColumnBorderColor(),
          'border-t-(length:--column-top-width)',
          isOver && 'drop-zone-highlight'
        )}
      >
        {/* Column header - enhanced styling */}
        <div className="flex items-center justify-between p-4 border-b border-border [.dark_&]:border-white/5">
        <div className="flex items-center gap-2.5">
          <h2 className="font-semibold text-sm text-foreground">
            {t(TASK_STATUS_LABELS[status])}
          </h2>
          {status === 'in_progress' && maxParallelTasks ? (
            <span className={cn(
              "column-count-badge",
              tasks.length >= maxParallelTasks && "bg-warning/20 text-warning border-warning/30"
            )}>
              {tasks.length}/{maxParallelTasks}
            </span>
          ) : (
            <span className="column-count-badge">
              {tasks.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {status === 'backlog' && (
            <>
              {onQueueAll && tasks.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:bg-nav-hover hover:text-foreground transition-colors"
                  onClick={onQueueAll}
                  title={t('queue.queueAll')}
                >
                  <ListPlus className="h-4 w-4" />
                </Button>
              )}
              {onAddClick && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:bg-nav-hover hover:text-foreground transition-colors"
                  onClick={onAddClick}
                  aria-label={t('kanban.addTaskAriaLabel')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
          {status === 'done' && onArchiveAll && tasks.length > 0 && !showArchived && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-nav-hover hover:text-foreground transition-colors"
              onClick={onArchiveAll}
              aria-label={t('tooltips.archiveAllDone')}
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {status === 'done' && archivedCount !== undefined && archivedCount > 0 && onToggleArchived && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 transition-colors relative',
                    showArchived
                      ? 'text-primary bg-primary/10 hover:bg-primary/20'
                      : 'text-muted-foreground hover:bg-nav-hover hover:text-foreground'
                  )}
                  onClick={onToggleArchived}
                  aria-pressed={showArchived}
                  aria-label={t('common:accessibility.toggleShowArchivedAriaLabel')}
                >
                  <Archive className="h-4 w-4" />
                  <span className="absolute -top-1 -right-1 text-[10px] font-medium bg-muted rounded-full min-w-[14px] h-[14px] flex items-center justify-center">
                    {archivedCount}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {showArchived ? t('common:projectTab.hideArchived') : t('common:projectTab.showArchived')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full px-3 pb-3 pt-2">
          <SortableContext
            items={taskIds}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3 min-h-[120px]">
              {tasks.length === 0 ? (
                <div
                  className={cn(
                    'empty-column-dropzone flex flex-col items-center justify-center py-6',
                    isOver && 'active'
                  )}
                >
                  {isOver ? (
                    <>
                      <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
                        <Plus className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium text-primary">{t('kanban.dropHere')}</span>
                    </>
                  ) : (
                    <>
                      {emptyState.icon}
                      <span className="mt-2 text-sm font-medium text-muted-foreground/70">
                        {emptyState.message}
                      </span>
                      {emptyState.subtext && (
                        <span className="mt-0.5 text-xs text-muted-foreground/50">
                          {emptyState.subtext}
                        </span>
                      )}
                    </>
                  )}
                </div>
              ) : (
                taskCards
              )}
            </div>
          </SortableContext>
        </ScrollArea>
      </div>
      </div>

    </div>
  );
}, droppableColumnPropsAreEqual);

export function KanbanBoard({ tasks, onTaskClick, onNewTaskClick, onRefresh, isRefreshing }: KanbanBoardProps) {
  const { t } = useTranslation(['tasks', 'dialogs', 'common']);
  const { toast } = useToast();
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const { showArchived, toggleShowArchived } = useViewState();

  // Project store for queue settings
  const projects = useProjectStore((state) => state.projects);

  // Get projectId from first task
  const projectId = tasks[0]?.projectId;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const appMaxParallelTasks = useSettingsStore((state) => state.settings.maxParallelTasks);
  const maxParallelTasks = resolveMaxParallelTasks(appMaxParallelTasks, project?.settings?.maxParallelTasks);

  // Queue processing lock to prevent race conditions
  const isProcessingQueueRef = useRef(false);


  // Worktree cleanup dialog state
  const [worktreeCleanupDialog, setWorktreeCleanupDialog] = useState<{
    open: boolean;
    taskId: string | null;
    taskTitle: string;
    worktreePath?: string;
    isProcessing: boolean;
    error?: string;
  }>({
    open: false,
    taskId: null,
    taskTitle: '',
    worktreePath: undefined,
    isProcessing: false,
    error: undefined
  });

  // Calculate archived count for Done column button
  const archivedCount = useMemo(() =>
    tasks.filter(t => t.metadata?.archivedAt).length,
    [tasks]
  );

  // Filter tasks based on archive status
  const filteredTasks = useMemo(() => {
    if (showArchived) {
      return tasks; // Show all tasks including archived
    }
    return tasks.filter((t) => !t.metadata?.archivedAt);
  }, [tasks, showArchived]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // 8px movement required before drag starts
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  // Get task order from store for custom ordering
  const taskOrder = useTaskStore((state) => state.taskOrder);

  const tasksByStatus = useMemo(() => {
    // Note: pr_created tasks are shown in the 'done' column since they're essentially complete
    // Note: error tasks are shown in the 'human_review' column since they need human attention
    const grouped: Record<typeof TASK_STATUS_COLUMNS[number], Task[]> = {
      backlog: [],
      queue: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: []
    };

    filteredTasks.forEach((task) => {
      // Map pr_created tasks to the done column, error tasks to human_review
      const targetColumn = getVisualColumn(task.status);
      if (grouped[targetColumn]) {
        grouped[targetColumn].push(task);
      }
    });

    // Sort tasks within each column
    Object.keys(grouped).forEach((status) => {
      const statusKey = status as typeof TASK_STATUS_COLUMNS[number];
      const columnTasks = grouped[statusKey];
      const columnOrder = taskOrder?.[statusKey];

      if (columnOrder && columnOrder.length > 0) {
        // Custom order exists: sort by order index
        // 1. Create a set of current task IDs for fast lookup (filters stale IDs)
        const currentTaskIds = new Set(columnTasks.map(t => t.id));

        // 2. Create valid order by filtering out stale IDs
        const validOrder = columnOrder.filter(id => currentTaskIds.has(id));
        const validOrderSet = new Set(validOrder);

        // 3. Find new tasks not in order (prepend at top)
        const newTasks = columnTasks.filter(t => !validOrderSet.has(t.id));
        // Sort new tasks by createdAt (newest first)
        newTasks.sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateB - dateA;
        });

        // 4. Sort ordered tasks by their index in validOrder
        // Pre-compute index map for O(n) sorting instead of O(n²) with indexOf
        const indexMap = new Map(validOrder.map((id, idx) => [id, idx]));
        const orderedTasks = columnTasks
          .filter(t => validOrderSet.has(t.id))
          .sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));

        // 5. Prepend new tasks at top, then ordered tasks
        grouped[statusKey] = [...newTasks, ...orderedTasks];
      } else {
        // No custom order: fallback to createdAt sort (newest first)
        grouped[statusKey].sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateB - dateA;
        });
      }
    });

    return grouped;
  }, [filteredTasks, taskOrder]);

  const handleArchiveAll = async () => {
    // Get projectId from the first task (all tasks should have the same projectId)
    const projectId = tasks[0]?.projectId;
    if (!projectId) {
      console.error('[KanbanBoard] No projectId found');
      return;
    }

    const doneTaskIds = tasksByStatus.done.map((t) => t.id);
    if (doneTaskIds.length === 0) return;

    const result = await archiveTasks(projectId, doneTaskIds);
    if (!result.success) {
      console.error('[KanbanBoard] Failed to archive tasks:', result.error);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setOverColumnId(null);
      return;
    }

    const overId = over.id as string;

    // Check if over a column
    if (isValidDropColumn(overId)) {
      setOverColumnId(overId);
      return;
    }

    // Check if over a task - get its column
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      setOverColumnId(overTask.status);
    }
  };

  /**
   * Handle status change with worktree cleanup dialog support
   * Consolidated handler that accepts an optional task object for the dialog title
   */
  const handleStatusChange = async (taskId: string, requestedStatus: TaskStatus, providedTask?: Task) => {
    const task = providedTask || tasks.find(t => t.id === taskId);
    let newStatus = requestedStatus;

    // ============================================
    // QUEUE SYSTEM: Enforce parallel task limit
    // Called from both the dropdown menu and the drag-and-drop handler.
    // Excludes the task itself from the count to handle re-entry (e.g., redundant
    // status change or race with auto-promotion). processQueue auto-promotion
    // calls persistTaskStatus directly, never this function.
    // ============================================
    if (newStatus === 'in_progress' && isQueueAtCapacity(taskId)) {
      console.log('[Queue] In Progress full, redirecting task to Queue');
      newStatus = 'queue';
    }

    const oldStatus = task?.status;
    const result = await persistTaskStatus(taskId, newStatus);

    if (!result.success) {
      if (result.worktreeExists) {
        // Show the worktree cleanup dialog
        setWorktreeCleanupDialog({
          open: true,
          taskId: taskId,
          taskTitle: task?.title || t('tasks:untitled'),
          worktreePath: result.worktreePath,
          isProcessing: false,
          error: undefined
        });
      } else {
        // Show error toast for other failures
        toast({
          title: t('common:errors.operationFailed'),
          description: result.error || t('common:errors.unknownError'),
          variant: 'destructive'
        });
      }
    }
    // Note: queue auto-promotion when a task leaves in_progress is handled by the
    // useEffect task status change listener (registerTaskStatusChangeListener), so
    // no explicit processQueue() call is needed here.
  };

  /**
   * Handle worktree cleanup confirmation
   */
  const handleWorktreeCleanupConfirm = async () => {
    if (!worktreeCleanupDialog.taskId) return;

    setWorktreeCleanupDialog(prev => ({ ...prev, isProcessing: true, error: undefined }));

    const result = await forceCompleteTask(worktreeCleanupDialog.taskId);

    if (result.success) {
      setWorktreeCleanupDialog({
        open: false,
        taskId: null,
        taskTitle: '',
        worktreePath: undefined,
        isProcessing: false,
        error: undefined
      });
    } else {
      // Keep dialog open with error state for retry - show actual error if available
      setWorktreeCleanupDialog(prev => ({
        ...prev,
        isProcessing: false,
        error: result.error || t('dialogs:worktreeCleanup.errorDescription')
      }));
    }
  };

  /**
   * Move all backlog tasks to queue
   */
  const handleQueueAll = async () => {
    const backlogTasks = tasksByStatus.backlog;
    if (backlogTasks.length === 0) return;

    let movedCount = 0;
    for (const task of backlogTasks) {
      const result = await persistTaskStatus(task.id, 'queue');
      if (result.success) {
        movedCount++;
      } else {
        console.error(`[Queue] Failed to move task ${task.id} to queue:`, result.error);
      }
    }

    // Auto-promote queued tasks to fill available capacity
    await processQueue();

    toast({
      title: t('queue.queueAllSuccess', { count: movedCount }),
      variant: 'default'
    });
  };

  /**
   * Automatically move tasks from Queue to In Progress to fill available capacity
   * Promotes multiple tasks if needed (e.g., after bulk queue)
   */
  const processQueue = useCallback(async () => {
    // Prevent concurrent executions to avoid race conditions
    if (isProcessingQueueRef.current) {
      console.log('[Queue] Already processing queue, skipping duplicate call');
      return;
    }

    isProcessingQueueRef.current = true;

    try {
      // Track tasks we've already attempted to promote (to avoid infinite retries)
      const attemptedTaskIds = new Set<string>();
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 10; // Safety limit to prevent infinite loop

      // Loop until capacity is full or queue is empty
      while (true) {
        // Get CURRENT state from store to ensure accuracy
        const currentTasks = useTaskStore.getState().tasks;
        const inProgressCount = currentTasks.filter((t) =>
          t.status === 'in_progress' && !t.metadata?.archivedAt
        ).length;
        // Tasks on a rate-limit hold are resumed by the main process at their reset
        // time; promoting them earlier would just hit the provider limit again.
        const queuedTasks = currentTasks.filter((t) =>
          t.status === 'queue' && !t.metadata?.archivedAt && !attemptedTaskIds.has(t.id) &&
          !isTaskOnRateLimitHold(t)
        );

        // Stop if no capacity, no queued tasks, or too many consecutive failures
        if (inProgressCount >= maxParallelTasks || queuedTasks.length === 0) {
          break;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(`[Queue] Stopping queue processing after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          break;
        }

        // Get the oldest task in queue (FIFO ordering)
        const nextTask = queuedTasks.sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateA - dateB; // Ascending order (oldest first)
        })[0];

        console.log(`[Queue] Auto-promoting task ${nextTask.id} from Queue to In Progress (${inProgressCount + 1}/${maxParallelTasks})`);
        const result = await persistTaskStatus(nextTask.id, 'in_progress');

        if (result.success) {
          // Reset consecutive failures on success
          consecutiveFailures = 0;
        } else {
          // If promotion failed, log error, mark as attempted, and skip to next task
          console.error(`[Queue] Failed to promote task ${nextTask.id} to In Progress:`, result.error);
          attemptedTaskIds.add(nextTask.id);
          consecutiveFailures++;
        }
      }

      // Log if we had failed tasks
      if (attemptedTaskIds.size > 0) {
        console.warn(`[Queue] Skipped ${attemptedTaskIds.size} task(s) that failed to promote`);
      }
    } finally {
      isProcessingQueueRef.current = false;
    }
  }, [maxParallelTasks]);

  // Register task status change listener for queue auto-promotion
  // This ensures processQueue() is called whenever a task leaves in_progress
  useEffect(() => {
    const unregister = useTaskStore.getState().registerTaskStatusChangeListener(
      (taskId, oldStatus, newStatus) => {
        // When a task leaves in_progress (e.g., goes to human_review), process the queue
        if (oldStatus === 'in_progress' && newStatus !== 'in_progress') {
          console.log(`[Queue] Task ${taskId} left in_progress, processing queue to fill slot`);
          processQueue();
        }
      }
    );

    // Cleanup: unregister listener when component unmounts
    return unregister;
  }, [processQueue]);

  // Get task order actions from store
  const reorderTasksInColumn = useTaskStore((state) => state.reorderTasksInColumn);
  const moveTaskToColumnTop = useTaskStore((state) => state.moveTaskToColumnTop);
  const saveTaskOrderToStorage = useTaskStore((state) => state.saveTaskOrder);
  const loadTaskOrder = useTaskStore((state) => state.loadTaskOrder);
  const setTaskOrder = useTaskStore((state) => state.setTaskOrder);

  const saveTaskOrder = useCallback((projectIdToSave: string) => {
    const success = saveTaskOrderToStorage(projectIdToSave);
    if (!success) {
      toast({
        title: t('kanban.orderSaveFailedTitle'),
        description: t('kanban.orderSaveFailedDescription'),
        variant: 'destructive'
      });
    }
    return success;
  }, [saveTaskOrderToStorage, toast, t]);

  // Load task order on mount and when project changes
  useEffect(() => {
    if (projectId) {
      loadTaskOrder(projectId);
    }
  }, [projectId, loadTaskOrder]);


  // Clean up stale task IDs from order when tasks change (e.g., after deletion)
  // This ensures the persisted order doesn't contain IDs for deleted tasks
  useEffect(() => {
    if (!projectId || !taskOrder) return;

    // Build a set of current task IDs for fast lookup
    const currentTaskIds = new Set(tasks.map(t => t.id));

    // Check each column for stale IDs
    let hasStaleIds = false;
    const cleanedOrder: typeof taskOrder = {
      backlog: [],
      queue: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: [],
      pr_created: [],
      error: []
    };

    for (const status of Object.keys(taskOrder) as Array<keyof typeof taskOrder>) {
      const columnOrder = taskOrder[status] || [];
      const cleanedColumnOrder = columnOrder.filter(id => currentTaskIds.has(id));

      cleanedOrder[status] = cleanedColumnOrder;

      // Check if any IDs were removed
      if (cleanedColumnOrder.length !== columnOrder.length) {
        hasStaleIds = true;
      }
    }

    // If stale IDs were found, update the order and persist
    if (hasStaleIds) {
      setTaskOrder(cleanedOrder);
      saveTaskOrder(projectId);
    }
  }, [tasks, taskOrder, projectId, setTaskOrder, saveTaskOrder]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    setOverColumnId(null);

    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    // Determine target status
    let newStatus: TaskStatus | null = null;
    let oldStatus: TaskStatus | null = null;

    // Get the task being dragged
    const task = tasks.find((t) => t.id === activeTaskId);
    if (!task) return;
    oldStatus = task.status;

    // Check if dropped on a column
    if (isValidDropColumn(overId)) {
      newStatus = overId;
    } else {
      // Check if dropped on another task - move to that task's column
      const overTask = tasks.find((t) => t.id === overId);
      if (overTask) {
        const task = tasks.find((t) => t.id === activeTaskId);
        if (!task) return;

        // Compare visual columns
        const taskVisualColumn = getVisualColumn(task.status);
        const overTaskVisualColumn = getVisualColumn(overTask.status);

        // Same visual column: reorder within column
        if (taskVisualColumn === overTaskVisualColumn) {
          // Ensure both tasks are in the order array before reordering
          // This handles tasks that existed before ordering was enabled
          const currentColumnOrder = taskOrder?.[taskVisualColumn] ?? [];
          const activeInOrder = currentColumnOrder.includes(activeTaskId);
          const overInOrder = currentColumnOrder.includes(overId);

          if (!activeInOrder || !overInOrder) {
            // Sync the current visual order to the stored order
            // This ensures existing tasks can be reordered
            const visualOrder = tasksByStatus[taskVisualColumn].map(t => t.id);
            setTaskOrder({
              ...taskOrder,
              [taskVisualColumn]: visualOrder
            } as TaskOrderState);
          }

          // Reorder tasks within the same column using the visual column key
          reorderTasksInColumn(taskVisualColumn, activeTaskId, overId);

          if (projectId) {
            saveTaskOrder(projectId);
          }
          return;
        }

        // Different visual column: move to that task's column (status change)
        // Use the visual column key for ordering to ensure consistency
        newStatus = overTask.status;
        moveTaskToColumnTop(activeTaskId, overTaskVisualColumn, taskVisualColumn);

        // Persist task order
        if (projectId) {
          saveTaskOrder(projectId);
        }
      }
    }

    if (!newStatus || newStatus === oldStatus) return;

    // Persist status change via handleStatusChange which enforces queue capacity,
    // handles worktree cleanup dialogs, and calls processQueue() when a task
    // leaves in_progress.
    await handleStatusChange(activeTaskId, newStatus, task);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Kanban header: refresh and queue settings */}
      <div className="flex items-center justify-end px-6 pt-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              onClick={() => window.dispatchEvent(new CustomEvent('open-app-settings', { detail: { section: 'agent', focusId: 'maxParallelTasks' } }))}
            >
              <Settings className="h-3.5 w-3.5" />
              {t('common:actions.settings')}
            </Button>
            {onRefresh && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="h-8 gap-1.5 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
                {isRefreshing ? t('common:buttons.refreshing') : t('tasks:refreshTasks')}
              </Button>
            )}
          </div>
        </div>
      {/* Kanban columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 gap-4 overflow-x-auto p-6 pt-2">
          {TASK_STATUS_COLUMNS.map((status) => (
            <DroppableColumn
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              onTaskClick={onTaskClick}
              onStatusChange={handleStatusChange}
              isOver={overColumnId === status}
              onAddClick={status === 'backlog' ? onNewTaskClick : undefined}
              onQueueAll={status === 'backlog' ? handleQueueAll : undefined}
              onArchiveAll={status === 'done' ? handleArchiveAll : undefined}
              maxParallelTasks={status === 'in_progress' ? maxParallelTasks : undefined}
              archivedCount={status === 'done' ? archivedCount : undefined}
              showArchived={status === 'done' ? showArchived : undefined}
              onToggleArchived={status === 'done' ? toggleShowArchived : undefined}
            />
          ))}
        </div>

        {/* Drag overlay - enhanced visual feedback */}
        <DragOverlay>
          {activeTask ? (
            <div className="drag-overlay-card kanban-compact">
              <TaskCard task={activeTask} onClick={() => {}} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Worktree cleanup confirmation dialog */}
      <WorktreeCleanupDialog
        open={worktreeCleanupDialog.open}
        taskTitle={worktreeCleanupDialog.taskTitle}
        worktreePath={worktreeCleanupDialog.worktreePath}
        isProcessing={worktreeCleanupDialog.isProcessing}
        error={worktreeCleanupDialog.error}
        onOpenChange={(open) => {
          if (!open && !worktreeCleanupDialog.isProcessing) {
            setWorktreeCleanupDialog(prev => ({ ...prev, open: false, error: undefined }));
          }
        }}
        onConfirm={handleWorktreeCleanupConfirm}
      />


    </div>
  );
}
