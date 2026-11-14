import { useState } from 'react';
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
import { Button, buttonVariants } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
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
import { CHAT_HISTORY_WIDTH } from '../lib/layout-widths';

interface ChatHistorySidebarProps {
  sessions: InsightsSessionSummary[];
  currentSessionId: string | null;
  isLoading: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  onUnarchiveSession?: (sessionId: string) => Promise<void>;
  showArchived?: boolean;
  onToggleShowArchived?: () => void;
  /** Conversations writing a reply now (shown with a spinner) */
  replyingSessionIds?: ReadonlySet<string>;
}

export function ChatHistorySidebar({
  sessions,
  currentSessionId,
  isLoading,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onUnarchiveSession,
  showArchived = false,
  onToggleShowArchived,
  replyingSessionIds
}: ChatHistorySidebarProps) {
  const { t } = useTranslation('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);


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

  return (
    <div className="relative flex h-full shrink-0 flex-col border-r border-border bg-sidebar" style={{ width: CHAT_HISTORY_WIDTH }}>
      {/* Window drag band over the top padding; the first row below sits level with the app sidebar's header row */}
      <div className="electron-drag absolute inset-x-0 top-0 z-10 h-6" />
      {/* Session list */}
      {/* Radix wraps the content in a display:table div that grows with it; make it a block so long
          titles truncate instead of pushing the item past the sidebar */}
      <ScrollArea className="flex-1" viewportClassName="[&>div]:!block">
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
                    onUnarchive={
                      onUnarchiveSession ? () => onUnarchiveSession(session.id) : undefined
                    }
                    isArchived={!!session.archivedAt}
                    isReplying={replyingSessionIds?.has(session.id) ?? false}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

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
            <AlertDialogAction onClick={handleDelete} className={buttonVariants({ variant: 'destructive', size: 'sm' })}>{t('actions.delete')}</AlertDialogAction>
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
  onUnarchive?: () => Promise<void>;
  isArchived: boolean;
  /** The chat is writing a reply */
  isReplying: boolean;
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
  onUnarchive,
  isArchived,
  isReplying
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
          // Same field look as the dialogs: hairline border, stronger on focus, no ring
          className={cn(
            'h-8 rounded-(--nav-item-radius) border-(--field-border-color) px-2 text-sm shadow-none placeholder:text-(--field-placeholder)',
            'focus-visible:border-(--field-border-focus) focus-visible:ring-0'
          )}
          autoFocus
        />
        {/* Same icon buttons as the page header (toggle history, new chat) */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-nav-hover hover:text-foreground"
          onClick={onSaveEdit}
          aria-label={t('accessibility.saveEditAriaLabel')}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-nav-hover hover:text-foreground"
          onClick={onCancelEdit}
          aria-label={t('accessibility.cancelEditAriaLabel')}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      role="button"
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
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Content with reserved space for the menu button */}
      <div className="flex min-w-0 flex-1 items-center gap-2 group-hover:pr-6 group-focus-within:pr-6">
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {isReplying && (
          <span className="inline-flex shrink-0 items-center" title={t('insights.replying')}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('insights.replying')}</span>
          </span>
        )}
        {isArchived && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-(--nav-label-color)">
            <Archive className="h-3 w-3" />
            <span className="sr-only">{t('insights.archived')}</span>
          </span>
        )}
      </div>

      {/* Absolutely positioned menu button */}
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
            {isArchived && onUnarchive && (
              <DropdownMenuItem onSelect={onUnarchive}>
                <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                {t('insights.unarchive')}
              </DropdownMenuItem>
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
    </div>
  );
}
