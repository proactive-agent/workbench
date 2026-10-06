import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Plus,
  CheckCircle2,
  AlertCircle,
  Search,
  FileText,
  FolderSearch,
  PanelLeftClose,
  PanelLeft,
  SquarePen,
  ArrowUp,
  ChevronDown,
  Paperclip,
  X
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import {
  useInsightsStore,
  loadInsightsSession,
  sendMessage,
  newSession,
  switchSession,
  deleteSession,
  deleteSessions,
  renameSession,
  archiveSession,
  archiveSessions,
  unarchiveSession,
  updateModelConfig,
  createTaskFromSuggestion,
  loadInsightsSessions
} from '../stores/insights-store';
import { useImageUpload } from './task-form/useImageUpload';
import { loadTasks } from '../stores/task-store';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { InsightsModelSelector } from './InsightsModelSelector';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import type { InsightsChatMessage, InsightsModelConfig, TaskMetadata, ImageAttachment } from '../../shared/types';
import {
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_LABELS,
  TASK_COMPLEXITY_COLORS,
  MAX_IMAGE_SIZE,
  parseInsightsError
} from '../../shared/constants';

// createSafeLink - factory function that creates a SafeLink component with i18n support
const createSafeLink = (opensInNewWindowText: string) => {
  return function SafeLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    // Validate URL - only allow http, https, and relative links
    const isValidUrl = href && (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('/') ||
      href.startsWith('#')
    );

    if (!isValidUrl) {
      // For invalid or potentially malicious URLs, render as plain text
      return <span className="text-muted-foreground">{children}</span>;
    }

    // External links get security attributes and accessibility indicator
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');

    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: '_blank',
          rel: 'noopener noreferrer',
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
};

interface InsightsProps {
  projectId: string;
}

export function Insights({ projectId }: InsightsProps) {
  const { t, i18n } = useTranslation('common');
  const session = useInsightsStore((state) => state.session);
  const sessions = useInsightsStore((state) => state.sessions);
  const status = useInsightsStore((state) => state.status);
  const streamingContent = useInsightsStore((state) => state.streamingContent);
  const currentTool = useInsightsStore((state) => state.currentTool);
  const isLoadingSessions = useInsightsStore((state) => state.isLoadingSessions);

  // Create markdown components with translated accessibility text
  const markdownComponents = useMemo(() => ({
    a: createSafeLink(t('accessibility.opensInNewWindow')),
  }), [t]);

  const [inputValue, setInputValue] = useState('');
  const [creatingTask, setCreatingTask] = useState<Set<string>>(new Set());
  const [taskCreated, setTaskCreated] = useState<Set<string>>(new Set());
  const [showSidebar, setShowSidebar] = useState(true);
  const showArchived = useInsightsStore((state) => state.showArchived);
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const pendingImages = useInsightsStore((state) => state.pendingImages);
  const setPendingImages = useInsightsStore((state) => state.setPendingImages);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null);

  // Model choice made before a session exists (or before it is persisted); the session's own config wins
  const [draftModelConfig, setDraftModelConfig] = useState<InsightsModelConfig | undefined>(undefined);
  const effectiveModelConfig = session?.modelConfig ?? draftModelConfig;

  const isLoading = status.phase === 'thinking' || status.phase === 'streaming';

  // Image upload hook
  const {
    isDragOver,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    addFiles,
    removeImage,
    canAddMore
  } = useImageUpload({
    images: pendingImages,
    onImagesChange: setPendingImages,
    disabled: isLoading,
    acceptAllFiles: true,
    onError: setImageError,
    errorMessages: {
      maxImagesReached: t('insights.images.maxImagesReached'),
      invalidImageType: t('insights.images.invalidType'),
      imageTooLarge: t('insights.attachments.tooLarge', { max: Math.round(MAX_IMAGE_SIZE / 1024 / 1024) }),
      processPasteFailed: t('insights.images.processFailed'),
      processDropFailed: t('insights.images.processFailed')
    }
  });

  // Scroll threshold in pixels - user is considered "at bottom" if within this distance
  const SCROLL_BOTTOM_THRESHOLD = 100;

  // Check if user is near the bottom of scroll area
  const checkIfAtBottom = useCallback((viewport: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // Handle scroll events to track user position
  const handleScroll = useCallback(() => {
    if (viewportEl) {
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
    }
  }, [viewportEl, checkIfAtBottom]);

  // Set up scroll listener and check initial position when viewport becomes available
  useEffect(() => {
    if (viewportEl) {
      // Check initial scroll position
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
      viewportEl.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewportEl.removeEventListener('scroll', handleScroll);
    }
  }, [viewportEl, handleScroll, checkIfAtBottom]);

  // Load the project's session on mount (IPC listeners are registered app-wide in useIpcListeners)
  useEffect(() => {
    loadInsightsSession(projectId, showArchived);
  }, [projectId]);

  // Reload sessions when showArchived changes (skip first run to avoid duplicate load with mount effect)
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    loadInsightsSessions(projectId, showArchived);
  }, [showArchived]);

  // Smart auto-scroll: only scroll if user is already at bottom
  // This allows users to scroll up to read previous messages without being
  // yanked back down during streaming responses
  useEffect(() => {
    if (isUserAtBottom && viewportEl) {
      viewportEl.scrollTop = viewportEl.scrollHeight;
    }
  }, [isUserAtBottom, viewportEl]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Reset task creation state when switching sessions
  useEffect(() => {
    setTaskCreated(new Set());
    setCreatingTask(new Set());
  }, [session?.id]);

  const handleSend = () => {
    const message = inputValue.trim();
    const hasImages = pendingImages.length > 0;
    if ((!message && !hasImages) || isLoading) return;

    setInputValue('');
    sendMessage(projectId, message, effectiveModelConfig, hasImages ? pendingImages : undefined);
    setPendingImages([]);
    setImageError(null);
    setIsUserAtBottom(true); // Resume auto-scroll when user sends a message
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewSession = async () => {
    await newSession(projectId);
    setTaskCreated(new Set());
    textareaRef.current?.focus();
  };

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId !== session?.id) {
      await switchSession(projectId, sessionId);
    }
  };

  const handleDeleteSession = async (sessionId: string): Promise<boolean> => {
    return await deleteSession(projectId, sessionId, showArchived);
  };

  const handleRenameSession = async (sessionId: string, newTitle: string): Promise<boolean> => {
    return await renameSession(projectId, sessionId, newTitle);
  };

  const handleArchiveSession = async (sessionId: string) => {
    try {
      await archiveSession(projectId, sessionId);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);
    } catch (error) {
      console.error(`Failed to archive session ${sessionId}:`, error);
    }
  };

  const handleUnarchiveSession = async (sessionId: string) => {
    try {
      await unarchiveSession(projectId, sessionId);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);
    } catch (error) {
      console.error(`Failed to unarchive session ${sessionId}:`, error);
    }
  };

  const handleDeleteSessions = async (sessionIds: string[]) => {
    try {
      const result = await deleteSessions(projectId, sessionIds);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);

      // Log partial failures for debugging
      if (result.failedIds && result.failedIds.length > 0) {
        console.warn(`Failed to delete ${result.failedIds.length} session(s):`, result.failedIds);
      }
    } catch (error) {
      console.error(`Failed to delete sessions ${sessionIds.join(', ')}:`, error);
    }
  };

  const handleArchiveSessions = async (sessionIds: string[]) => {
    try {
      const result = await archiveSessions(projectId, sessionIds);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);

      // Log partial failures for debugging
      if (result.failedIds && result.failedIds.length > 0) {
        console.warn(`Failed to archive ${result.failedIds.length} session(s):`, result.failedIds);
      }
    } catch (error) {
      console.error(`Failed to archive sessions ${sessionIds.join(', ')}:`, error);
    }
  };

  const handleToggleShowArchived = () => {
    useInsightsStore.getState().setShowArchived(!showArchived);
  };

  const handleCreateTask = async (
    messageId: string,
    taskIndex: number,
    taskData: { title: string; description: string; metadata?: TaskMetadata }
  ) => {
    const taskKey = `${messageId}-${taskIndex}`;
    setCreatingTask(prev => new Set(prev).add(taskKey));
    try {
      const task = await createTaskFromSuggestion(
        projectId,
        taskData.title,
        taskData.description,
        taskData.metadata
      );

      if (task) {
        setTaskCreated(prev => new Set(prev).add(taskKey));
        // Reload tasks to show the new task in the kanban
        loadTasks(projectId);
      }
    } finally {
      setCreatingTask(prev => {
        const next = new Set(prev);
        next.delete(taskKey);
        return next;
      });
    }
  };

  const handleModelConfigChange = async (config: InsightsModelConfig) => {
    // Always apply locally so the choice sticks before the conversation exists on disk
    setDraftModelConfig(config);
    if (session?.id) {
      await updateModelConfig(projectId, session.id, config);
    }
  };

  const messages = session?.messages || [];
  const isEmpty = messages.length === 0 && !streamingContent && !currentTool && !isLoading;
  const canSend = (inputValue.trim().length > 0 || pendingImages.length > 0) && !isLoading;

  // Time-of-day greeting, refreshed every minute so it follows the clock while the page stays open
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const greetingKey =
    hour < 5 ? 'insights.greeting.night'
      : hour < 12 ? 'insights.greeting.morning'
        : hour < 18 ? 'insights.greeting.afternoon'
          : 'insights.greeting.evening';

  // Auto-grow the composer textarea with its content (capped by max-h-96)
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 384)}px`;
  }, [inputValue, isEmpty]);

  // The composer moves between the empty-state and conversation layouts; keep focus on it
  useEffect(() => {
    if (!isLoading) {
      textareaRef.current?.focus();
    }
  }, [isEmpty]);

  const parsedError = status.phase === 'error' && status.error ? parseInsightsError(status.error) : null;
  const errorBanner = parsedError ? (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {parsedError.code ? (
        <div className="min-w-0 space-y-1">
          <p>{t(`insights.errors.${parsedError.code}`)}</p>
          <p className="break-words text-xs text-muted-foreground">{parsedError.details}</p>
        </div>
      ) : (
        <span className="min-w-0 break-words">{parsedError.details}</span>
      )}
    </div>
  ) : null;

  const modelSelector = (
    <InsightsModelSelector
      currentConfig={effectiveModelConfig}
      onConfigChange={handleModelConfigChange}
      disabled={isLoading}
    />
  );

  const composer = (
    <div className="space-y-2">
      <div
        className={cn(
          'relative rounded-(--radius-composer) bg-card',
          'shadow-[0_4px_20px_rgba(0,0,0,0.075),0_0_0_1px_var(--input)]',
          'transition-shadow duration-150 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.1),0_0_0_1px_var(--input)]'
        )}
      >
        {/* Image preview strip */}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
            {pendingImages.map((image) => (
              <div key={image.id} className="group relative" title={image.filename}>
                {image.thumbnail ? (
                  <button
                    type="button"
                    onClick={() => setPreviewAttachment(image)}
                    className="block h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
                    aria-label={t('insights.attachments.preview', { name: image.filename })}
                  >
                    <img src={image.thumbnail} alt={image.filename} className="h-full w-full object-cover" />
                  </button>
                ) : (
                  <div className="flex h-14 max-w-56 items-center gap-2 overflow-hidden rounded-lg border border-border bg-muted px-3">
                    <FileText className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="min-w-0 truncate text-xs text-foreground">{image.filename}</span>
                  </div>
                )}
                {/* Remove button centered on the attachment's top-right corner */}
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute right-0 top-0 flex h-4 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  title={t('insights.images.removeImage')}
                  aria-label={t('insights.images.removeImage')}
                >
                  <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                </button>
              </div>
            ))}
            <span className="text-xs text-muted-foreground">
              {t('insights.attachments.count', { count: pendingImages.length })}
            </span>
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isEmpty ? t('insights.placeholder') : t('insights.replyPlaceholder')}
          aria-label={t('insights.placeholder')}
          spellCheck
          lang={i18n.language}
          className={cn(
            'block max-h-96 min-h-[3rem] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-4 pb-1',
            'text-[0.9375rem] leading-relaxed text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
          )}
          disabled={isLoading}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex items-center gap-0.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length > 0) void addFiles(files);
              }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading || !canAddMore}
                  aria-label={t('insights.attachments.add')}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('insights.attachments.add')}</TooltipContent>
            </Tooltip>
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            aria-label={isLoading ? t('insights.sending') : t('insights.send')}
            title={isLoading ? t('insights.sending') : t('insights.send')}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
            )}
          </button>
        </div>

        {/* Drag-over overlay */}
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-(--radius-composer) border-2 border-dashed border-primary bg-primary/5">
            <span className="text-sm font-medium text-primary">
              {t('insights.attachments.dragOver')}
            </span>
          </div>
        )}
      </div>

      {/* Image error */}
      {imageError && (
        <p className="px-1 text-xs text-destructive">{imageError}</p>
      )}
    </div>
  );

  return (
    <div className="flex h-full bg-background">
      {/* Chat History Sidebar */}
      {showSidebar && (
        <ChatHistorySidebar
          sessions={sessions}
          currentSessionId={session?.id || null}
          isLoading={isLoadingSessions}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onArchiveSession={handleArchiveSession}
          onUnarchiveSession={handleUnarchiveSession}
          onDeleteSessions={handleDeleteSessions}
          onArchiveSessions={handleArchiveSessions}
          showArchived={showArchived}
          onToggleShowArchived={handleToggleShowArchived}
        />
      )}

      {/* Main Chat Area - files can be dropped anywhere in it */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Minimal top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setShowSidebar(!showSidebar)}
                aria-label={showSidebar ? t('insights.hideHistory') : t('insights.showHistory')}
              >
                {showSidebar ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeft className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showSidebar ? t('insights.hideHistory') : t('insights.showHistory')}</TooltipContent>
          </Tooltip>
          <h2 className="sr-only">{t('insights.title')}</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={handleNewSession}
                aria-label={t('insights.newChat')}
              >
                <SquarePen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('insights.newChat')}</TooltipContent>
          </Tooltip>
        </div>

        {isEmpty ? (
          /* Empty state: greeting + centered composer */
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4">
            <div className="flex w-full max-w-[672px] flex-1 flex-col justify-center pb-[12vh]">
              <h1 className="mb-8 flex items-center justify-center gap-3 text-center font-heading text-[2.125rem] font-normal! leading-tight tracking-tight text-foreground">
                <SparkMark className="h-9 w-9 shrink-0" />
                <span>{t(greetingKey)}</span>
              </h1>

              {composer}

              {/* Meta row */}
              <div className="mt-2 flex items-center justify-end text-sm">
                {modelSelector}
              </div>

              {errorBanner && <div className="mt-6">{errorBanner}</div>}
            </div>
          </div>
        ) : (
          <>
            {/* Messages */}
            <ScrollArea className="min-h-0 flex-1" onViewportRef={setViewportEl}>
              <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    markdownComponents={markdownComponents}
                    onCreateTask={handleCreateTask}
                    creatingTask={creatingTask}
                    taskCreated={taskCreated}
                    onPreviewImage={setPreviewAttachment}
                  />
                ))}

                {/* Streaming message */}
                {(streamingContent || currentTool) && (
                  <div className="space-y-2">
                    {streamingContent && (
                      <div className="prose prose-sm dark:prose-invert max-w-none text-[0.9375rem] leading-relaxed text-foreground">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {streamingContent}
                        </ReactMarkdown>
                      </div>
                    )}
                    {/* Tool usage indicator */}
                    {currentTool && (
                      <ToolIndicator name={currentTool.name} input={currentTool.input} />
                    )}
                    <SparkMark className="h-5 w-5" animate />
                  </div>
                )}

                {/* Thinking indicator */}
                {status.phase === 'thinking' && !streamingContent && !currentTool && (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <SparkMark className="h-5 w-5" animate />
                    {t('insights.thinking')}
                  </div>
                )}

                {errorBanner}
              </div>
            </ScrollArea>

            {/* Composer pinned to the bottom */}
            <div className="relative shrink-0 px-4 pb-3">
              <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-background to-transparent" />
              <div className="mx-auto max-w-3xl">
                {composer}
                <div className="mt-1 flex items-center justify-between gap-2 pl-4 text-sm">
                  <span className="truncate text-[0.6875rem] text-muted-foreground">
                    {t('insights.images.pasteHint')} · {t('insights.sendHint')}
                  </span>
                  {modelSelector}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <AttachmentPreviewDialog
        projectId={projectId}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </div>
  );
}

// Claude symbol (Wikimedia Commons "Claude_AI_symbol.svg"), drawn in the brand clay colour
interface SparkMarkProps {
  className?: string;
  animate?: boolean;
}

const CLAUDE_SYMBOL_PATH =
  'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z';

function SparkMark({ className, animate }: SparkMarkProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="#D97757"
      aria-hidden="true"
      className={cn(animate && 'animate-[spin_2.4s_linear_infinite]', className)}
    >
      <path d={CLAUDE_SYMBOL_PATH} />
    </svg>
  );
}

interface MessageBubbleProps {
  message: InsightsChatMessage;
  markdownComponents: Components;
  onCreateTask: (messageId: string, taskIndex: number, taskData: { title: string; description: string; metadata?: TaskMetadata }) => void;
  creatingTask: Set<string>;
  taskCreated: Set<string>;
  onPreviewImage: (image: ImageAttachment) => void;
}

function MessageBubble({
  message,
  markdownComponents,
  onPreviewImage,
  onCreateTask,
  creatingTask,
  taskCreated
}: MessageBubbleProps) {
  const { t } = useTranslation('common');
  const isUser = message.role === 'user';

  if (isUser) {
    const attachments = message.images || [];
    return (
      <div className="flex flex-col items-end gap-1.5">
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {attachments.map((file) =>
              file.thumbnail ? (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onPreviewImage(file)}
                  className="cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
                  aria-label={t('insights.attachments.preview', { name: file.filename })}
                >
                  <img
                    src={file.thumbnail}
                    alt={file.filename}
                    className="max-h-[200px] max-w-[200px] rounded-lg border border-border object-contain"
                  />
                </button>
              ) : (
                <div
                  key={file.id}
                  className="flex h-12 max-w-64 items-center gap-2 rounded-lg border border-border bg-muted px-3"
                  title={file.filename}
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 truncate text-sm text-foreground">{file.filename}</span>
                </div>
              )
            )}
          </div>
        )}
        {message.content && (
          <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-muted px-4 py-2.5 text-[0.9375rem] leading-relaxed text-foreground">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {message.content && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[0.9375rem] leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}

      {/* Tool usage history for assistant messages */}
      {message.toolsUsed && message.toolsUsed.length > 0 && (
        <ToolUsageHistory tools={message.toolsUsed} />
      )}

      {/* Task suggestion cards */}
      {message.suggestedTasks && message.suggestedTasks.length > 0 && (
        <div className="space-y-3">
          {message.suggestedTasks.map((task, index) => {
            const taskKey = `${message.id}-${index}`;
            const isCreating = creatingTask.has(taskKey);
            const isCreated = taskCreated.has(taskKey);

            return (
              <div key={taskKey} className="rounded-xl border border-border bg-card p-4">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t('insights.suggestedTask')}
                </div>
                <h4 className="mb-1.5 text-[0.9375rem] font-medium text-foreground">
                  {task.title}
                </h4>
                <p className="mb-3 text-sm text-muted-foreground">
                  {task.description}
                </p>
                {task.metadata && (task.metadata.category || task.metadata.complexity) && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {task.metadata.category && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-xs',
                          TASK_CATEGORY_COLORS[task.metadata.category]
                        )}
                      >
                        {TASK_CATEGORY_LABELS[task.metadata.category] ||
                          task.metadata.category}
                      </Badge>
                    )}
                    {task.metadata.complexity && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-xs',
                          TASK_COMPLEXITY_COLORS[task.metadata.complexity]
                        )}
                      >
                        {TASK_COMPLEXITY_LABELS[task.metadata.complexity] ||
                          task.metadata.complexity}
                      </Badge>
                    )}
                  </div>
                )}
                <Button
                  size="sm"
                  variant={isCreated ? 'outline' : 'default'}
                  onClick={() => onCreateTask(message.id, index, task)}
                  disabled={isCreating || isCreated}
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('insights.creating')}
                    </>
                  ) : isCreated ? (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      {t('insights.taskCreated')}
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      {t('insights.createTask')}
                    </>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const getToolIcon = (toolName: string) => {
  switch (toolName) {
    case 'Read':
      return FileText;
    case 'Glob':
      return FolderSearch;
    case 'Grep':
      return Search;
    default:
      return FileText;
  }
};

// Tool usage history component for showing tools used in completed messages
interface ToolUsageHistoryProps {
  tools: Array<{
    name: string;
    input?: string;
    timestamp: Date;
  }>;
}

function ToolUsageHistory({ tools }: ToolUsageHistoryProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  // Group tools by name for summary
  const toolCounts = tools.reduce((acc, tool) => {
    acc[tool.name] = (acc[tool.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-2 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          {Object.entries(toolCounts).map(([name, count]) => {
            const Icon = getToolIcon(name);
            return (
              <span key={name} className="flex items-center gap-0.5">
                <Icon className="h-3 w-3" />
                <span>{count}</span>
              </span>
            );
          })}
        </span>
        <span>{t('insights.tools.toolsUsed', { count: tools.length })}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="mt-2 space-y-1 rounded-xl border border-border p-3">
          {tools.map((tool, index) => {
            const Icon = getToolIcon(tool.name);
            return (
              <div
                key={`${tool.name}-${index}`}
                className="flex items-center gap-2 text-xs"
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="font-medium text-foreground">{tool.name}</span>
                {tool.input && (
                  <span className="max-w-[250px] truncate text-muted-foreground">
                    {tool.input}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Tool indicator component for showing what the AI is currently doing
interface ToolIndicatorProps {
  name: string;
  input?: string;
}

function ToolIndicator({ name, input }: ToolIndicatorProps) {
  const { t } = useTranslation('common');

  // Get friendly name and icon for each tool
  const getToolInfo = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return { icon: FileText, label: t('insights.tools.readingFile') };
      case 'Glob':
        return { icon: FolderSearch, label: t('insights.tools.searchingFiles') };
      case 'Grep':
        return { icon: Search, label: t('insights.tools.searchingCode') };
      default:
        return { icon: Loader2, label: toolName };
    }
  };

  const { icon: Icon, label } = getToolInfo(name);

  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm">
      <Icon className="h-4 w-4 shrink-0 animate-pulse text-muted-foreground" />
      <span className="font-medium text-foreground">{label}</span>
      {input && (
        <span className="max-w-[300px] truncate text-muted-foreground">
          {input}
        </span>
      )}
    </div>
  );
}
