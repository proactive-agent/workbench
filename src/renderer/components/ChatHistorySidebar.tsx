import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  Pencil,
  Check,
  X,
  MoreHorizontal,
  Loader2,
  Archive,
  ArchiveRestore
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Checkbox } from './ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog';
import { cn } from '../lib/utils';
import type { InsightsSessionSummary } from '../../shared/types';

interface ChatHistorySidebarProps {
  sessions: InsightsSessionSummary[];
  currentSessionId: string | null;
  isLoading: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  onArchiveSession?: (sessionId: string) => Promise<void>;
  onUnarchiveSession?: (sessionId: string) => Promise<void>;
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  onArchiveSessions?: (sessionIds: string[]) => Promise<void>;
  showArchived?: boolean;
  onToggleShowArchived?: () => void;
}

export function ChatHistorySidebar({
  sessions,
  currentSessionId,
  isLoading,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  onUnarchiveSession,
  onDeleteSessions,
  onArchiveSessions,
  showArchived = false,
  onToggleShowArchived
}: ChatHistorySidebarProps) {
  const { t } = useTranslation('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);


  // Prune selectedIds when sessions change - removes IDs for sessions no longer displayed
  // Also resets when showArchived toggles
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(sessions.map((s) => s.id));
      const pruned = new Set([...prev].filter((id) => validIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [sessions, showArchived]);

  const handleToggleSelect = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(sessions.map((s) => s.id)));
  }, [sessions]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleStartEdit = (session: InsightsSessionSummary) => {
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveEdit = async () => {
    if (editingId && editTitle.trim()) {
      await onRenameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
  };

  const handleDelete = async () => {
    if (deleteSessionId) {
      await onDeleteSession(deleteSessionId);
      setDeleteSessionId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size > 0 && onDeleteSessions) {
      try {
        await onDeleteSessions(Array.from(selectedIds));
        setSelectedIds(new Set());
      } catch (error) {
        console.error('Failed to delete sessions:', error);
      } finally {
        setBulkDeleteOpen(false);
      }
    }
  };

  const handleBulkArchive = () => {
    if (selectedIds.size > 0 && onArchiveSessions) {
      setBulkArchiveOpen(true);
    }
  };

  const handleBulkArchiveConfirmed = async () => {
    if (selectedIds.size > 0 && onArchiveSessions) {
      try {
        await onArchiveSessions(Array.from(selectedIds));
        setSelectedIds(new Set());
      } catch (error) {
        console.error('Failed to archive sessions:', error);
      } finally {
        setBulkArchiveOpen(false);
      }
    }
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const d = new Date(date);
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return t('insights.today');
    } else if (diffDays === 1) {
      return t('insights.yesterday');
    } else if (diffDays < 7) {
      return t('insights.daysAgo', { count: diffDays });
    } else {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  };

  // Group sessions by date
  const groupedSessions = sessions.reduce((groups, session) => {
    const dateLabel = formatDate(session.updatedAt);
    if (!groups[dateLabel]) {
      groups[dateLabel] = [];
    }
    groups[dateLabel].push(session);
    return groups;
  }, {} as Record<string, InsightsSessionSummary[]>);

  // Sessions selected for bulk delete preview
  const sessionsToDelete = sessions.filter((s) => selectedIds.has(s.id));

  return (
    <div className="relative flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      {/* Window drag band over the top padding; the first row below sits level with the app sidebar's header row */}
      <div className="electron-drag absolute inset-x-0 top-0 z-10 h-6" />
      {/* Select All / Clear links */}
      {isSelectionMode && sessions.length > 0 && (
        <div className="flex items-center justify-between px-4 pb-1.5">
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={handleSelectAll}
          >
            {t('accessibility.selectAllAriaLabel')}
          </button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={handleClearSelection}
          >
            {t('accessibility.clearSelectionAriaLabel')}
          </button>
        </div>
      )}

      {/* Session list */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="flex h-14 items-center justify-center pt-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex h-14 items-center justify-center px-3 pt-6 text-sm text-muted-foreground">
            {t('insights.noConversations')}
          </div>
        ) : (
          <div className="px-2 pb-2 pt-6">
            {Object.entries(groupedSessions).map(([dateLabel, dateSessions]) => (
              <div key={dateLabel} className="mb-3 space-y-px">
                <div className="nav-section-label flex h-8 items-center px-2 text-[0.8125rem]">
                  {dateLabel}
                </div>
                {dateSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={session.id === currentSessionId}
                    isEditing={editingId === session.id}
                    editTitle={editTitle}
                    onSelect={() => onSelectSession(session.id)}
                    onStartEdit={() => handleStartEdit(session)}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                    onEditTitleChange={setEditTitle}
                    onDelete={() => setDeleteSessionId(session.id)}
                    onArchive={onArchiveSession ? () => onArchiveSession(session.id) : undefined}
                    onUnarchive={
                      onUnarchiveSession ? () => onUnarchiveSession(session.id) : undefined
                    }
                    isArchived={!!session.archivedAt}
                    isSelectionMode={isSelectionMode}
                    isSelected={selectedIds.has(session.id)}
                    onToggleSelect={() => handleToggleSelect(session.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Bulk action toolbar */}
      {isSelectionMode && selectedIds.size > 0 && (
        <div className="flex items-center gap-2 overflow-hidden min-w-0 border-t border-border px-2 py-2">
          <Button
            variant="destructive"
            size="sm"
            className="min-w-0 flex-1 text-xs"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="shrink-0 mr-1.5 h-3.5 w-3.5" />
            <span className="truncate">{t('selection.deleteSelected')} ({selectedIds.size})</span>
          </Button>
          {onArchiveSessions && (
            <Button
              variant="secondary"
              size="sm"
              className="min-w-0 flex-1 text-xs"
              onClick={handleBulkArchive}
            >
              <Archive className="shrink-0 mr-1.5 h-3.5 w-3.5" />
              <span className="truncate">{t('insights.archiveSelected')} ({selectedIds.size})</span>
            </Button>
          )}
        </div>
      )}

      {/* Single delete confirmation dialog */}
      <AlertDialog open={!!deleteSessionId} onOpenChange={() => setDeleteSessionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('insights.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('insights.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t('actions.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('insights.bulkDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('insights.bulkDeleteDescription', { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sessionsToDelete.length > 0 && (
            <div className="mt-4 max-h-32 overflow-y-auto rounded-lg border border-border px-4 py-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('insights.conversationsToDelete')}:
              </p>
              <ul className="space-y-0.5">
                {sessionsToDelete.map((s) => (
                  <li key={s.id} className="truncate text-xs text-foreground/80">
                    {s.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('insights.bulkDeleteConfirm', { count: selectedIds.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk archive confirmation dialog */}
      <AlertDialog open={bulkArchiveOpen} onOpenChange={setBulkArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('insights.archiveConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('insights.archiveConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkArchiveConfirmed}>
              {t('insights.archiveConfirmButton', { count: selectedIds.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface SessionItemProps {
  session: InsightsSessionSummary;
  isActive: boolean;
  isEditing: boolean;
  editTitle: string;
  onSelect: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditTitleChange: (title: string) => void;
  onDelete: () => void;
  onArchive?: () => Promise<void>;
  onUnarchive?: () => Promise<void>;
  isArchived: boolean;
  isSelectionMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}

function SessionItem({
  session,
  isActive,
  isEditing,
  editTitle,
  onSelect,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onDelete,
  onArchive,
  onUnarchive,
  isArchived,
  isSelectionMode,
  isSelected,
  onToggleSelect
}: SessionItemProps) {
  const { t } = useTranslation('common');
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSaveEdit();
    } else if (e.key === 'Escape') {
      onCancelEdit();
    }
  };

  if (isEditing) {
    return (
      <div className="group flex h-8 items-center gap-1">
        <Input
          value={editTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-7 px-2 text-sm"
          autoFocus
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onSaveEdit}
          aria-label={t('accessibility.saveEditAriaLabel')}
        >
          <Check className="h-3.5 w-3.5 text-success" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onCancelEdit}
          aria-label={t('accessibility.cancelEditAriaLabel')}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div
      role={isSelectionMode ? 'checkbox' : 'button'}
      aria-checked={isSelectionMode ? isSelected : undefined}
      tabIndex={0}
      title={`${session.title} · ${t('insights.messageCount', { count: session.messageCount })}`}
      className={cn(
        'group relative flex h-8 cursor-pointer items-center rounded-(--nav-item-radius) px-2 text-sm text-muted-foreground',
        'transition-colors duration-150 ease-out',
        'hover:bg-nav-hover hover:text-nav-hover-foreground',
        'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
        isActive && 'bg-nav-active text-nav-active-foreground hover:bg-nav-active hover:text-nav-active-foreground',
        isArchived && 'opacity-50'
      )}
      onClick={isSelectionMode ? onToggleSelect : onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          isSelectionMode ? onToggleSelect() : onSelect();
        }
      }}
    >
      {/* Content with reserved space for the menu button */}
      <div className={cn('flex min-w-0 flex-1 items-center gap-2', !isSelectionMode && 'group-hover:pr-6 group-focus-within:pr-6')}>
        {isSelectionMode && (
          <div className="flex shrink-0 items-center">
            <Checkbox
              checked={isSelected}
              className="h-4 w-4"
              aria-hidden
              tabIndex={-1}
            />
          </div>
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {isArchived && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-(--nav-label-color)">
            <Archive className="h-3 w-3" />
            <span className="sr-only">{t('insights.archived')}</span>
          </span>
        )}
      </div>

      {/* Absolutely positioned menu button - hidden in selection mode */}
      {!isSelectionMode && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-transparent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
              aria-label={t('accessibility.moreOptionsAriaLabel')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={5} className="w-36 z-[100]">
            <DropdownMenuItem onSelect={onStartEdit}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              {t('accessibility.renameAriaLabel')}
            </DropdownMenuItem>
            {isArchived ? (
              onUnarchive && (
                <DropdownMenuItem onSelect={onUnarchive}>
                  <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                  {t('insights.unarchive')}
                </DropdownMenuItem>
              )
            ) : (
              onArchive && (
                <DropdownMenuItem onSelect={onArchive}>
                  <Archive className="mr-2 h-3.5 w-3.5" />
                  {t('insights.archive')}
                </DropdownMenuItem>
              )
            )}
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t('accessibility.deleteAriaLabel')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
