import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, ChevronDown, Loader2, Search } from 'lucide-react';
import type { Task } from '../../../shared/types';
import { TaskListIcon } from '../icons/app-icons';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';
import { PHASE_CONFIG } from './types';

interface TaskSelectorProps {
  terminalId: string;
  backlogTasks: Task[];
  associatedTask?: Task;
  onTaskSelect: (taskId: string) => void;
  onClearTask: () => void;
  onNewTaskClick?: () => void;
}

/**
 * Task picker for Claude terminals, laid out like the worktree selector:
 * a pinned "New task" action, a search box, and the matching tasks below it.
 */
export function TaskSelector({
  terminalId: _terminalId,
  backlogTasks,
  associatedTask,
  onTaskSelect,
  onClearTask,
  onNewTaskClick,
}: TaskSelectorProps) {
  const { t } = useTranslation('terminal');
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<number, HTMLDivElement>());
  const listboxId = useId();

  const executionPhase = associatedTask?.executionProgress?.phase || 'idle';
  const phaseConfig = PHASE_CONFIG[executionPhase];
  const PhaseIcon = phaseConfig.icon;
  const isPhaseActive =
    executionPhase === 'planning' ||
    executionPhase === 'coding' ||
    executionPhase === 'qa_review' ||
    executionPhase === 'qa_fixing';

  // Available tasks (the linked one is not listed), filtered by the search query
  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return backlogTasks
      .filter((task) => task.id !== associatedTask?.id)
      .filter((task) => !query || task.title.toLowerCase().includes(query));
  }, [backlogTasks, associatedTask?.id, searchQuery]);

  // Reset search and keyboard focus whenever the list opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setFocusedIndex(-1);
    }
  }, [isOpen]);

  // Keep the focused option in view while navigating with the keyboard
  useEffect(() => {
    if (focusedIndex >= 0) {
      itemRefs.current.get(focusedIndex)?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  const selectTask = (taskId: string) => {
    setIsOpen(false);
    onTaskSelect(taskId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filteredTasks.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && focusedIndex >= 0 && filteredTasks[focusedIndex]) {
      e.preventDefault();
      selectTask(filteredTasks[focusedIndex].id);
    }
  };

  const getOptionId = (index: number) => `${listboxId}-option-${index}`;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        {/* Same neutral trigger as the worktree selector */}
        <button
          type="button"
          className="flex h-6 items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          title={associatedTask?.title}
        >
          {associatedTask ? (
            <>
              {isPhaseActive ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <PhaseIcon className="h-3 w-3" />
              )}
              <span>{phaseConfig.label}</span>
            </>
          ) : (
            <>
              <TaskListIcon className="h-3 w-3 shrink-0" />
              <span>{t('taskSelector.selectTask')}</span>
            </>
          )}
          <ChevronDown className="h-2.5 w-2.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        {/* Pinned actions: new task, and clearing the linked task */}
        {(onNewTaskClick || associatedTask) && (
          <>
            <div className="p-1">
              {onNewTaskClick && (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-nav-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(false);
                    onNewTaskClick();
                  }}
                >
                  <Plus className="mr-2 h-3 w-3" />
                  {t('taskSelector.newTask')}
                </button>
              )}
              {associatedTask && (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-nav-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(false);
                    onClearTask();
                  }}
                  title={associatedTask.title}
                >
                  <X className="mr-2 h-3 w-3 shrink-0" />
                  <span className="truncate">{t('taskSelector.clearTask')}</span>
                </button>
              )}
            </div>
            <div className="border-t border-border" />
          </>
        )}

        {/* Search input */}
        <div className="flex items-center px-2 py-1.5">
          <Search className="mr-2 h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="search"
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-activedescendant={focusedIndex >= 0 ? getOptionId(focusedIndex) : undefined}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setFocusedIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('taskSelector.searchPlaceholder')}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="border-t border-border" />

        {/* Matching tasks */}
        <div className="max-h-[min(500px,60vh)] overflow-y-auto">
          <div id={listboxId} role="listbox" aria-label={t('taskSelector.availableTasks')} className="p-1">
            {filteredTasks.length === 0 ? (
              <div className="py-2 text-center text-xs text-muted-foreground">
                {backlogTasks.length === 0 ? t('taskSelector.noTasks') : t('taskSelector.noResults')}
              </div>
            ) : (
              filteredTasks.map((task, index) => (
                <div
                  key={task.id}
                  id={getOptionId(index)}
                  ref={(el) => {
                    if (el) itemRefs.current.set(index, el);
                    else itemRefs.current.delete(index);
                  }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={focusedIndex === index}
                  className={cn(
                    'cursor-pointer truncate rounded-sm px-2 py-1.5 text-xs',
                    focusedIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectTask(task.id);
                  }}
                  onMouseEnter={() => setFocusedIndex(index)}
                  title={task.title}
                >
                  {task.title}
                </div>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
