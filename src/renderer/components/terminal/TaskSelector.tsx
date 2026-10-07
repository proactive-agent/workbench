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
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          title={associatedTask?.title}
        >
          {associatedTask ? (
            <>
              {isPhaseActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PhaseIcon className="h-4 w-4" strokeWidth={1.75} />
              )}
              <span>{phaseConfig.label}</span>
            </>
          ) : (
            <>
              <TaskListIcon className="h-4 w-4 shrink-0" />
              <span>{t('taskSelector.selectTask')}</span>
            </>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-[15rem] max-w-[22rem] p-1.5"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        {/* Pinned actions: new task, and clearing the linked task */}
        {(onNewTaskClick || associatedTask) && (
          <>
            <div>
              {onNewTaskClick && (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-nav-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(false);
                    onNewTaskClick();
                  }}
                >
                  <Plus className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  {t('taskSelector.newTask')}
                </button>
              )}
              {associatedTask && (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-nav-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(false);
                    onClearTask();
                  }}
                  title={associatedTask.title}
                >
                  <X className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="truncate">{t('taskSelector.clearTask')}</span>
                </button>
              )}
            </div>
            <div className="-mx-1.5 my-1.5 h-px bg-border" />
          </>
        )}

        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
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
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--nav-label-color)"
          />
        </div>

        <div className="-mx-1.5 my-1.5 h-px bg-border" />

        {/* Matching tasks */}
        <div className="max-h-[min(500px,60vh)] overflow-y-auto">
          <div id={listboxId} role="listbox" aria-label={t('taskSelector.availableTasks')}>
            {filteredTasks.length === 0 ? (
              <div className="px-3 py-2 text-sm text-(--nav-label-color)">
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
                    'cursor-pointer truncate rounded-lg px-3 py-2 text-sm text-foreground',
                    focusedIndex === index ? 'bg-nav-hover' : 'hover:bg-nav-hover'
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
