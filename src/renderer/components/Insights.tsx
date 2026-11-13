import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Plus,
  Check,
  CheckCircle2,
  Copy,
  Pencil,
  Search,
  FileText,
  FolderSearch,
  Terminal,
  Wrench,
  PanelLeft,
  SquarePen,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Square,
  CornerDownLeft,
  ChevronDown,
  Paperclip,
  X
} from 'lucide-react';
import { MarkdownContent } from './ui/markdown-content';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn, formatLongRelativeTime } from '../lib/utils';
import { stripTaskSuggestions } from '../../shared/utils/task-suggestions';
import { ClawdIcon, GitHubIcon, GitLabIcon, GraphIcon, InsightsIcon, KanbanIcon, McpIcon, MessagesIcon } from './icons/app-icons';
import { BUILTIN_CONNECTOR_META } from './settings/connector-meta';
import {
  useInsightsStore,
  chatModelConfig,
  changeChatModelConfig,
  withDefaultModelConfig,
  replyingSessionIds,
  loadInsightsSession,
  openInsightsPage,
  sendMessage,
  stopMessage,
  regenerateMessage,
  editMessage,
  newSession,
  switchSession,
  deleteSession,
  renameSession,
  unarchiveSession,
  createTaskFromSuggestion,
  loadInsightsSessions
} from '../stores/insights-store';
import { useImageUpload } from './task-form/useImageUpload';
import { loadTasks } from '../stores/task-store';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { BrowserDrawerButton } from './browser-drawer/BrowserDrawerButton';
import {
  useBrowserDrawerStore,
  APP_SIDEBAR_COLLAPSED_WIDTH,
  APP_SIDEBAR_WIDTH,
  CHAT_MIN_WIDTH,
} from '../stores/browser-drawer-store';
import { IS_DEV_BUILD, TITLE_BAR_STRIP_HEIGHT } from '../lib/title-bar';
import { InsightsModelSelector } from './InsightsModelSelector';
import { InsightsMcpMenu } from './InsightsMcpMenu';
import { InsightsSlashMenu } from './InsightsSlashMenu';
import { InsightsAgentWindowButton } from './InsightsAgentWindowButton';
import { useSharedSessionWindow } from '../hooks/useSharedSessionWindow';
import { InsightsChatNameButton } from './InsightsChatNameButton';
import { splitSlashCommands, useSlashCommandMenu } from './insights-slash-commands';
import { useWindowClaudeAccountId } from '../hooks/useWindowClaudeAccount';
import { closedAgentWindow, mayNameClosedAgent, sessionTargetNow, windowSessionTitle, type SessionTarget } from '../lib/session-targets';
import { useProjectStore } from '../stores/project-store';
import { agentSessionName, chatSessionName } from '../../shared/utils/session-names';
import { useSettingsStore } from '../stores/settings-store';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import type { InsightsChatMessage, InsightsModelConfig, TaskMetadata, ImageAttachment } from '../../shared/types';
import {
  MAX_IMAGE_SIZE,
  parseInsightsError
} from '../../shared/constants';

interface InsightsProps {
  projectId: string;
}

/**
 * The page's own window drag strip above its top bar, under the Windows/Linux window controls (in
 * development builds the content area's strip and the DEVELOPMENT BUILD strip are above it instead).
 * The browser drawer starts at the same height, so its top border and the top bar's line meet
 */
const TOP_STRIP_HEIGHT = IS_DEV_BUILD ? 0 : TITLE_BAR_STRIP_HEIGHT;

/** The chat history sidebar's width (px, ChatHistorySidebar's w-64) */
const CHAT_HISTORY_WIDTH = 256;
/** The width (px) collapsing the app's sidebar gives the chat */
const APP_SIDEBAR_COLLAPSE_GAIN = APP_SIDEBAR_WIDTH - APP_SIDEBAR_COLLAPSED_WIDTH;


/**
 * The chat history was closed by the browser drawer (not by the user), so the drawer may open it
 * again: kept for the app's life, like the history's own state, across visits to the page
 */
const historyClosedByDrawer = { current: false };

export function Insights({ projectId }: InsightsProps) {
  const { t, i18n } = useTranslation('common');
  const session = useInsightsStore((state) => state.session);
  const sessions = useInsightsStore((state) => state.sessions);
  // Chats writing a reply (several can at once): marked in the history
  const backgroundRuns = useInsightsStore((state) => state.backgroundRuns);
  const status = useInsightsStore((state) => state.status);
  const streamingContent = useInsightsStore((state) => state.streamingContent);
  const currentTool = useInsightsStore((state) => state.currentTool);
  const isLoadingSessions = useInsightsStore((state) => state.isLoadingSessions);

  // The composer's text, kept in the store so it is still there after a visit to another page
  const inputValue = useInsightsStore((state) => state.composerText);
  const setInputValue = useInsightsStore((state) => state.setComposerText);
  // Where the caret is in the composer (the `/` menu follows it)
  const [caret, setCaret] = useState(0);
  // The chat or agent window the next message goes to: a session name pasted into the composer,
  // shown as an attachment (one at a time: the latest paste wins). It belongs to the chat it was
  // chosen in: another chat starts without one, and coming back to the page finds it again
  const chatKey = session?.id ?? 'new';
  const composerSendTo = useInsightsStore((state) => state.composerSendTo);
  const sendTo = composerSendTo?.chatKey === chatKey ? composerSendTo.target : null;
  const setSendTo = useCallback((next: SessionTarget | null | ((current: SessionTarget | null) => SessionTarget | null)) => {
    useInsightsStore.setState((state) => {
      const current = state.composerSendTo?.chatKey === chatKey ? state.composerSendTo.target : null;
      const target = typeof next === 'function' ? next(current) : next;
      return { composerSendTo: target ? { chatKey, target } : null };
    });
  }, [chatKey]);
  const projectPath = useProjectStore((state) => state.projects.find((project) => project.id === projectId)?.path);
  const [creatingTask, setCreatingTask] = useState<Set<string>>(new Set());
  const [taskCreated, setTaskCreated] = useState<Set<string>>(new Set());
  // The chat history beside the chat (kept as the user left it)
  const showSidebar = useInsightsStore((state) => state.chatHistoryOpen);
  const setShowSidebar = useInsightsStore((state) => state.setChatHistoryOpen);
  const showArchived = useInsightsStore((state) => state.showArchived);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const pendingImages = useInsightsStore((state) => state.pendingImages);
  const setPendingImages = useInsightsStore((state) => state.setPendingImages);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The composer's box: the `/` menu is placed at it
  const composerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null);

  // Model choice made before a session exists (or before it is persisted); the session's own config wins
  const draftModelConfig = useInsightsStore((state) => state.draftModelConfig);
  // The browser drawer beside the chat (its top border runs on along the top bar while it is open)
  const drawerOpen = useBrowserDrawerStore((state) => state.open);
  const drawerWidth = useBrowserDrawerStore((state) => state.width);
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const historyClosedByDrawerRef = historyClosedByDrawer;
  const appSidebarSaved = useSettingsStore((state) => state.settings.sidebarCollapsed ?? false);
  const appSidebarCollapsedByDrawer = useBrowserDrawerStore((state) => state.appSidebarCollapsedByDrawer);
  const setAppSidebarCollapsedByDrawer = useBrowserDrawerStore((state) => state.setAppSidebarCollapsedByDrawer);
  const narrowDrawerBy = useBrowserDrawerStore((state) => state.narrowBy);
  /** The drawer as the last change left it: which way it moved decides what may close or open */
  const lastDrawerRef = useRef({ open: false, width: drawerWidth });
  // Opening or widening the drawer until the chat is narrower than CHAT_MIN_WIDTH closes the chat
  // history, then collapses the app's sidebar; narrowing or closing the drawer opens them again in
  // the other order, each once the chat keeps that width with it. Only what the drawer closed opens
  // again: a history or sidebar the user closed stays closed. Only the drawer growing closes them,
  // so one the user opens again (which narrows the drawer by its width) stays open
  useLayoutEffect(() => {
    const last = lastDrawerRef.current;
    lastDrawerRef.current = { open: drawerOpen, width: drawerWidth };
    const grew = drawerOpen && (!last.open || drawerWidth > last.width);
    const shrank = drawerOpen ? last.open && drawerWidth < last.width : last.open;
    let width = chatColumnRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    if (grew && width < CHAT_MIN_WIDTH) {
      if (showSidebar) {
        historyClosedByDrawerRef.current = true;
        setShowSidebar(false, false);
        width += CHAT_HISTORY_WIDTH;
      }
      if (width < CHAT_MIN_WIDTH && !appSidebarSaved && !appSidebarCollapsedByDrawer) setAppSidebarCollapsedByDrawer(true);
      return;
    }
    if (!shrank) return;
    if (appSidebarCollapsedByDrawer) {
      if (width - APP_SIDEBAR_COLLAPSE_GAIN < CHAT_MIN_WIDTH) return;
      setAppSidebarCollapsedByDrawer(false);
      width -= APP_SIDEBAR_COLLAPSE_GAIN;
    }
    if (!showSidebar && historyClosedByDrawerRef.current && width - CHAT_HISTORY_WIDTH >= CHAT_MIN_WIDTH) {
      historyClosedByDrawerRef.current = false;
      setShowSidebar(true, false);
    }
    // The drawer's changes only: not the sidebars', so the user's toggles stay as they are
  }, [drawerOpen, drawerWidth]);
  // The app's sidebar is the drawer's to collapse only on this page
  useEffect(() => () => setAppSidebarCollapsedByDrawer(false), [setAppSidebarCollapsedByDrawer]);
  const toggleHistory = () => {
    // Opened again by the user: the drawer gives up the room the history takes, so the chat keeps its width
    if (!showSidebar && historyClosedByDrawerRef.current) narrowDrawerBy(CHAT_HISTORY_WIDTH);
    historyClosedByDrawerRef.current = false;
    setShowSidebar(!showSidebar);
  };

  const effectiveModelConfig = chatModelConfig({ session, draftModelConfig });

  // The composer's `/` menu: Claude Code's slash commands and skills, with the Clawd button on
  // The account the chat's turns run on (an API profile in use, else the project's Claude
  // account): the commands depend on it
  const claudeAccountId = useWindowClaudeAccountId();
  const apiProfileId = useSettingsStore((state) => state.activeProfileId);
  const slashMenu = useSlashCommandMenu({
    projectId,
    accountKey: apiProfileId ? `api:${apiProfileId}` : claudeAccountId,
    enabled: effectiveModelConfig?.agentMode === true,
    value: inputValue,
    caret,
    onInsert: (value, nextCaret) => {
      setInputValue(value);
      setCaret(nextCaret);
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(nextCaret, nextCaret));
    },
  });

  const isLoading = status.phase === 'thinking' || status.phase === 'streaming';
  const replyingIds = replyingSessionIds({ session, status, backgroundRuns });
  // An agent window running this chat's session too: while its Claude Code works, the chat waits
  // (sending, editing or regenerating would branch the session)
  const sharedWindow = useSharedSessionWindow(projectId, session);
  const windowBusy = sharedWindow.busy;

  // Stop turns disabled once clicked, until the reply has ended
  const [stopRequested, setStopRequested] = useState(false);
  useEffect(() => {
    if (!isLoading) setStopRequested(false);
  }, [isLoading]);
  const handleStop = () => {
    setStopRequested(true);
    void stopMessage(projectId);
  };

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

  // The chat stays pinned to the bottom (an opened chat starts there, a reply being written is
  // followed) until the user scrolls up; scrolling back down pins it again
  const stickToBottomRef = useRef(true);
  // Shows the scroll-to-bottom button while the user is away from the latest messages
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const scrollToBottom = useCallback(() => {
    if (viewportEl) viewportEl.scrollTop = viewportEl.scrollHeight;
  }, [viewportEl]);

  useEffect(() => {
    if (!viewportEl) return;
    const updatePosition = () => {
      const atBottom = checkIfAtBottom(viewportEl);
      stickToBottomRef.current = atBottom;
      setIsAwayFromBottom(!atBottom);
    };
    viewportEl.addEventListener('scroll', updatePosition, { passive: true });
    // Content grows while a reply streams and while messages, code and images lay out; a chat
    // that becomes too short to scroll is at its bottom without a scroll event
    const content = viewportEl.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom();
      updatePosition();
    });
    if (content) observer.observe(content);
    observer.observe(viewportEl);
    stickToBottomRef.current = true;
    setIsAwayFromBottom(false);
    scrollToBottom();
    return () => {
      viewportEl.removeEventListener('scroll', updatePosition);
      observer.disconnect();
    };
  }, [viewportEl, checkIfAtBottom, scrollToBottom]);

  // The page opens as it was left: the last chat, or the New chat page (IPC listeners are
  // registered app-wide in useIpcListeners)
  useEffect(() => {
    openInsightsPage(projectId, showArchived);
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

  // Opening a chat from the history shows its latest messages
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setIsAwayFromBottom(false);
    scrollToBottom();
  }, [session?.id, scrollToBottom]);

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
    if ((!message && !hasImages) || isLoading || windowBusy) return;

    setInputValue('');
    const to = sendTo ? { kind: sendTo.kind, name: sendTo.name, ...(sendTo.title ? { title: sendTo.title } : {}) } : undefined;
    sendMessage(projectId, message, effectiveModelConfig, hasImages ? pendingImages : undefined, to);
    setSendTo(null);
    setPendingImages([]);
    setImageError(null);
    stickToBottomRef.current = true; // Follow the reply to a message just sent
    scrollToBottom();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // The open `/` menu takes the arrows, Enter, Tab and Escape
    if (slashMenu.handleKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewSession = async () => {
    // Choices made on an earlier New chat page don't carry over from a conversation
    if (session) useInsightsStore.getState().setDraftModelConfig(undefined);
    await newSession(projectId);
    setTaskCreated(new Set());
    textareaRef.current?.focus();
  };

  // The sidebar's Claude item clicked while the page shows: a new chat, as the New chat button
  const newChatRequest = useInsightsStore((state) => state.newChatRequest);
  const handledNewChatRef = useRef(newChatRequest);
  useEffect(() => {
    if (newChatRequest === handledNewChatRef.current) return;
    handledNewChatRef.current = newChatRequest;
    void handleNewSession();
  }, [newChatRequest]);

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

  // Applied at once so the choice sticks before the conversation exists on disk
  const handleModelConfigChange = (config: InsightsModelConfig) => changeChatModelConfig(projectId, config);

  const messages = session?.messages || [];
  const isEmpty = messages.length === 0 && !streamingContent && !currentTool && !isLoading;
  const canSend = (inputValue.trim().length > 0 || pendingImages.length > 0) && !isLoading && !windowBusy;

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

  // The composer's text split around the listed slash commands it names (colored with the Clawd
  // button on)
  const inputParts = useMemo(() => splitSlashCommands(inputValue, slashMenu.names), [inputValue, slashMenu.names]);
  const commandHighlight = inputParts.some((part) => part.command);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Auto-grow the composer textarea with its content (capped by max-h-96)
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 384)}px`;
  }, [inputValue, isEmpty]);

  // The copy behind the field leaves out the field's scrollbar and follows its scroll
  useLayoutEffect(() => {
    const field = textareaRef.current;
    const copy = highlightRef.current;
    if (!field || !copy) return;
    copy.style.right = `${field.offsetWidth - field.clientWidth}px`;
    copy.scrollTop = field.scrollTop;
  });

  // The composer moves between the empty-state and conversation layouts; keep focus on it
  useEffect(() => {
    if (!isLoading) {
      textareaRef.current?.focus();
    }
  }, [isEmpty]);

  const parsedError = status.phase === 'error' && status.error ? parseInsightsError(status.error) : null;
  const errorBanner = parsedError ? (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
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

  // Kanban button: gives Claude the project's task tools in this conversation (kept with the
  // conversation's model settings)
  const kanbanTools = effectiveModelConfig?.kanbanTools === true;
  const baseModelConfig = withDefaultModelConfig(effectiveModelConfig);
  const toggleKanbanTools = () => {
    void handleModelConfigChange({ ...baseModelConfig, kanbanTools: !kanbanTools });
  };

  // GitHub and GitLab buttons: Claude can use the gh or glab CLI in this conversation (kept with
  // the conversation's model settings). A CLI that isn't installed leaves its button off and
  // disabled
  const detectedClis = useDetectedClis();
  const cliToggle = (key: 'githubTools' | 'gitlabTools', cli: 'gh' | 'glab', Icon: React.ElementType, label: string) => {
    const installed = detectedClis[cli];
    const on = installed && effectiveModelConfig?.[key] === true;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The wrapper keeps the tooltip on a disabled button */}
          <span className="inline-flex">
            <button
              type="button"
              onClick={() => void handleModelConfigChange({ ...baseModelConfig, [key]: !on })}
              disabled={isLoading || !installed}
              aria-pressed={on}
              aria-label={label}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-40',
                on
                  ? 'bg-primary/15 text-primary hover:bg-primary/20'
                  : 'text-muted-foreground hover:bg-nav-hover hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{installed ? label : t('insights.cliNotFound', { name: label })}</TooltipContent>
      </Tooltip>
    );
  };
  const githubButton = cliToggle('githubTools', 'gh', GitHubIcon, t('insights.githubTools'));
  const gitlabButton = cliToggle('gitlabTools', 'glab', GitLabIcon, t('insights.gitlabTools'));
  // Clawd button: the conversation's turns get what an agent window has (changing files, any
  // command, the user's MCP servers, slash commands and skills); off again, the same session
  // continues read-only
  const agentMode = effectiveModelConfig?.agentMode === true;
  const clawdButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void handleModelConfigChange({ ...baseModelConfig, agentMode: !agentMode })}
          disabled={isLoading}
          aria-pressed={agentMode}
          aria-label={t('insights.agentMode.label')}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-40',
            agentMode
              ? 'bg-primary/15 text-primary hover:bg-primary/20'
              : 'text-muted-foreground hover:bg-nav-hover hover:text-foreground'
          )}
        >
          <ClawdIcon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{t(agentMode ? 'insights.agentMode.on' : 'insights.agentMode.off')}</TooltipContent>
    </Tooltip>
  );
  const kanbanButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleKanbanTools}
          disabled={isLoading}
          aria-pressed={kanbanTools}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-40',
            kanbanTools
              ? 'bg-primary/15 text-primary hover:bg-primary/20'
              : 'text-muted-foreground hover:bg-nav-hover hover:text-foreground'
          )}
        >
          <KanbanIcon className="h-4 w-4 shrink-0" />
          {t('insights.kanbanTools.label')}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(kanbanTools ? 'insights.kanbanTools.on' : 'insights.kanbanTools.off')}</TooltipContent>
    </Tooltip>
  );

  // MCP button: the conversation's MCP servers, starting from the Connectors defaults (kept with
  // the conversation's model settings)
  const connectorSettings = useSettingsStore((state) => state.settings.mcpConnectors);
  const mcpButton = (
    <InsightsMcpMenu
      value={effectiveModelConfig?.mcpConnectors ?? getDefaultMcpConnectorIds(connectorSettings)}
      onChange={(mcpConnectors) => void handleModelConfigChange({ ...baseModelConfig, mcpConnectors })}
      disabled={isLoading}
    />
  );

  const modelSelector = (
    <InsightsModelSelector
      currentConfig={effectiveModelConfig}
      onConfigChange={handleModelConfigChange}
      disabled={isLoading}
    />
  );

  // Attach-files button: inside the composer for a new chat, under it in a conversation
  const attachButton = (
    <>
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
            <Paperclip className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('insights.attachments.add')}</TooltipContent>
      </Tooltip>
    </>
  );

  const composer = (
    <div className="space-y-2">
      <div
        ref={composerRef}
        className={cn(
          'relative rounded-(--radius-composer) bg-background',
          'shadow-[0_4px_20px_rgba(0,0,0,0.075),0_0_0_1px_var(--input)]',
          'transition-shadow duration-150 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.1),0_0_0_1px_var(--input)]'
        )}
      >
        {slashMenu.open && (
          <InsightsSlashMenu
            anchorRef={composerRef}
            items={slashMenu.items}
            activeIndex={slashMenu.activeIndex}
            loading={slashMenu.loading}
            error={slashMenu.error}
            onSelect={slashMenu.select}
            onHover={slashMenu.setActiveIndex}
          />
        )}
        {/* Attachments: the message's recipient (a pasted session name), then files */}
        {(pendingImages.length > 0 || sendTo) && (
          <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
            {sendTo && (
              <div className="group relative" title={sendTo.name}>
                <div
                  className="flex h-14 max-w-64 items-center gap-2.5 overflow-hidden rounded-lg border border-border bg-muted px-3"
                  aria-label={t(sendTo.kind === 'chat' ? 'insights.sendTo.chat' : 'insights.sendTo.agent', { title: sendTo.title || sendTo.name })}
                >
                  {sendTo.kind === 'chat'
                    ? <InsightsIcon className="h-5 w-5 shrink-0 text-primary" />
                    : <ClawdIcon className="h-5 w-5 shrink-0 text-primary" />}
                  <div className="min-w-0">
                    <div className="truncate text-xs text-foreground">{sendTo.title || sendTo.name}</div>
                    <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">{sendTo.name}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSendTo(null)}
                  className="absolute right-0 top-0 flex h-4 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  title={t('insights.sendTo.remove')}
                  aria-label={t('insights.sendTo.remove')}
                >
                  <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                </button>
              </div>
            )}
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
            {pendingImages.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('insights.attachments.count', { count: pendingImages.length })}
              </span>
            )}
          </div>
        )}

        {/* The listed slash commands in the text show in the primary color: the text is drawn by a
            copy behind the field (same box, wrapping and scroll), and the field's own text is
            transparent while it holds one */}
        <div className="relative">
        {commandHighlight && (
          <div
            ref={highlightRef}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 overflow-hidden whitespace-pre-wrap break-words',
              isEmpty ? 'px-4 pt-4 pb-1' : 'py-3 pl-4 pr-12',
              'text-[0.9375rem] leading-relaxed text-foreground',
              isLoading && 'opacity-60'
            )}
          >
            {inputParts.map((part, index) => (
              part.command ? <span key={index} className="text-primary">{part.text}</span> : part.text
            ))}
            {/* A last empty line takes its room, as in the field */}
            {inputValue.endsWith('\n') && ' '}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            // A chat or agent window's name: the message's recipient, not text
            const text = e.clipboardData?.files?.length ? '' : e.clipboardData?.getData('text/plain') ?? '';
            const selfName = session ? chatSessionName(session.id) : null;
            const target = text ? sessionTargetNow(text, projectPath, selfName) : null;
            // A closed agent window's name: asked of the app, pasted as text when no window had it
            if (!target && text && mayNameClosedAgent(text, projectPath, selfName)) {
              e.preventDefault();
              const start = e.currentTarget.selectionStart ?? inputValue.length;
              const end = e.currentTarget.selectionEnd ?? start;
              void closedAgentWindow(text, projectPath, selfName).then((closed) => {
                if (closed) setSendTo(closed);
                else setInputValue((value) => value.slice(0, start) + text + value.slice(end));
              });
              return;
            }
            if (target) {
              e.preventDefault();
              setSendTo(target);
              // An agent window is shown by its session's name once read (its title is just "Claude")
              if (target.kind === 'agent' && projectPath) {
                void windowSessionTitle(projectPath, target.name).then((title) => {
                  if (title) setSendTo((current) => (current?.name === target.name ? { ...current, title } : current));
                });
              }
              return;
            }
            void handlePaste(e);
          }}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          placeholder={isEmpty ? t('insights.placeholder') : t('insights.replyPlaceholder')}
          aria-label={t('insights.placeholder')}
          spellCheck
          lang={i18n.language}
          className={cn(
            'relative block max-h-96 w-full resize-none overflow-y-auto border-0 bg-transparent',
            isEmpty ? 'min-h-[3rem] px-4 pt-4 pb-1' : 'min-h-[3rem] py-3 pl-4 pr-12',
            'text-[0.9375rem] leading-relaxed text-foreground placeholder:text-(--field-placeholder)',
            'focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
            // The copy behind shows the text; a light selection lets it show through
            commandHighlight && 'text-transparent caret-foreground selection:bg-primary/25'
          )}
          disabled={isLoading}
        />
        </div>

        {isEmpty ? (
          /* Toolbar (new chat): attach on the left; the model and send on the right */
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex items-center gap-1">{attachButton}{mcpButton}{githubButton}{gitlabButton}{clawdButton}{kanbanButton}</div>
            <div className="flex min-w-0 items-center gap-1.5">
              {modelSelector}
              {/* Send button only appears once there is something to send; it turns into stop while Claude works */}
              {isLoading ? (
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={stopRequested}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
                  aria-label={t('insights.stop')}
                  title={t('insights.stop')}
                >
                  <Square className="h-3 w-3 fill-current" />
                </button>
              ) : canSend && (
                <button
                  type="button"
                  onClick={handleSend}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90"
                  aria-label={t('insights.send')}
                  title={t('insights.send')}
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
                </button>
              )}
            </div>
          </div>
        ) : (
          /* Reply: send sits inside the single-line field, always visible (disabled until there is something
             to send); it turns into stop while Claude works */
          isLoading ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopRequested}
              className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-nav-hover disabled:pointer-events-none disabled:opacity-40"
              aria-label={t('insights.stop')}
              title={t('insights.stop')}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label={t('insights.send')}
            title={t('insights.send')}
          >
            <CornerDownLeft className="h-4 w-4" />
          </button>
          )
        )}

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
      {windowBusy && sharedWindow.terminalId && (
        <p className="px-1 text-xs text-muted-foreground">
          {t('insights.agentWindow.working', { name: agentSessionName(sharedWindow.terminalId) })}
        </p>
      )}
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
          // Reloads (new chat, model or MCP changes) keep the list on screen; the spinner is for the first load
          isLoading={isLoadingSessions && sessions.length === 0}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onUnarchiveSession={handleUnarchiveSession}
          showArchived={showArchived}
          onToggleShowArchived={handleToggleShowArchived}
          replyingSessionIds={replyingIds}
        />
      )}

      {/* Main Chat Area - files can be dropped anywhere in it */}
      <div
        ref={chatColumnRef}
        className="flex min-w-0 flex-1 flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Top bar, below the window drag strip: the history toggle and the browser drawer's button
            share the first row, as far from the bar's top as the button is from the right edge, and
            "New chat" sits below the toggle. While the drawer is open the bar's top line continues
            the drawer's top border to the chat history. The bar doubles as the window drag area */}
        <div className="electron-drag shrink-0" style={{ height: TOP_STRIP_HEIGHT }} />
        <div
          className={cn(
            'electron-drag flex shrink-0 items-start justify-between border-t px-3 pt-3',
            drawerOpen ? 'border-border' : 'border-transparent'
          )}
        >
          <div className="flex flex-col items-start gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="electron-no-drag h-8 w-8 text-muted-foreground"
                  onClick={toggleHistory}
                  aria-label={showSidebar ? t('insights.hideHistory') : t('insights.showHistory')}
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{showSidebar ? t('insights.hideHistory') : t('insights.showHistory')}</TooltipContent>
            </Tooltip>
            <h2 className="sr-only">{t('insights.title')}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="electron-no-drag h-8 w-8 text-muted-foreground"
                  onClick={handleNewSession}
                  aria-label={t('insights.newChat')}
                >
                  <SquarePen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('insights.newChat')}</TooltipContent>
            </Tooltip>
          </div>
          {/* The browser drawer's button, and under it the chat's session in an agent window */}
          <div className="flex flex-col items-end gap-3">
            <BrowserDrawerButton projectId={projectId} />
            <InsightsAgentWindowButton projectId={projectId} session={session} replying={isLoading} windowId={sharedWindow.terminalId} />
            <InsightsChatNameButton session={session} />
          </div>
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

              {errorBanner && <div className="mt-6">{errorBanner}</div>}
            </div>
          </div>
        ) : (
          <>
            {/* Messages */}
            {/* Radix lays the messages out as a table, as wide as their widest line (a tool call's command
                that doesn't wrap): block keeps them within the chat's width */}
            <ScrollArea className="min-h-0 flex-1" viewportClassName="[&>div]:block!" onViewportRef={setViewportEl}>
              <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
                {messages.map((message, index) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    onRegenerate={
                      // The latest reply can be written again once Claude is done
                      index === messages.length - 1 && message.role === 'assistant' && !isLoading && !windowBusy
                        ? () => {
                          setTaskCreated(new Set());
                          regenerateMessage(projectId, effectiveModelConfig);
                        }
                        : undefined
                    }
                    onEdit={
                      // A sent message can be edited once Claude is done; the chat after it is
                      // replaced by the edited message's reply
                      message.role === 'user' && !isLoading && !windowBusy
                        ? (content) => {
                          setTaskCreated(new Set());
                          stickToBottomRef.current = true; // Follow the edited message's reply
                          editMessage(projectId, message.id, content, effectiveModelConfig);
                        }
                        : undefined
                    }
                    onCreateTask={handleCreateTask}
                    creatingTask={creatingTask}
                    taskCreated={taskCreated}
                    onPreviewImage={setPreviewAttachment}
                  />
                ))}

                {/* Streaming message */}
                {/* Suggestion lines become cards when the reply is done; they are hidden while it streams */}
                {stripTaskSuggestions(streamingContent) && <MarkdownContent>{stripTaskSuggestions(streamingContent)}</MarkdownContent>}

                {/* While Claude works: the spinning mark, with the tool being called, or "Thinking"
                    between tools (nothing next to it while text streams in) */}
                {isLoading && (
                  <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
                    <SparkMark className="h-5 w-5 shrink-0" animate />
                    {currentTool ? (
                      <ToolIndicator name={currentTool.name} input={currentTool.input} />
                    ) : !streamingContent ? (
                      t('insights.thinking')
                    ) : null}
                  </div>
                )}

                {errorBanner}
              </div>
            </ScrollArea>

            {/* Composer pinned to the bottom */}
            <div className="relative shrink-0 px-4 pb-3">
              <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-background to-transparent" />
              <button
                type="button"
                onClick={() => viewportEl?.scrollTo({ top: viewportEl.scrollHeight, behavior: 'smooth' })}
                className={cn(
                  'absolute -top-12 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-opacity hover:text-foreground',
                  isAwayFromBottom ? 'opacity-100' : 'pointer-events-none opacity-0'
                )}
                aria-label={t('insights.scrollToBottom')}
                title={t('insights.scrollToBottom')}
                aria-hidden={!isAwayFromBottom}
                tabIndex={isAwayFromBottom ? 0 : -1}
              >
                <ArrowDown className="h-4 w-4" />
              </button>
              <div className="mx-auto max-w-3xl">
                {composer}
                {/* Under the field: attach, disclaimer, model */}
                <div className="mt-1.5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
                  <div className="flex items-center gap-1">{attachButton}{mcpButton}{githubButton}{gitlabButton}{clawdButton}{kanbanButton}</div>
                  <span className="truncate text-xs text-muted-foreground">{t('insights.disclaimer')}</span>
                  <div className="flex justify-end">{modelSelector}</div>
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

/** Detected gh and glab CLIs; the main process detects them once at startup */
let detectedClisCache: { gh: boolean; glab: boolean } | null = null;

function useDetectedClis(): { gh: boolean; glab: boolean } {
  const [clis, setClis] = useState(detectedClisCache ?? { gh: false, glab: false });
  useEffect(() => {
    if (detectedClisCache) return;
    let cancelled = false;
    window.electronAPI.getCliToolsInfo().then((result) => {
      if (!result.success || !result.data) return;
      detectedClisCache = { gh: result.data.gh.found, glab: result.data.glab.found };
      if (!cancelled) setClis(detectedClisCache);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return clis;
}

interface MessageBubbleProps {
  message: InsightsChatMessage;
  onCreateTask: (messageId: string, taskIndex: number, taskData: { title: string; description: string; metadata?: TaskMetadata }) => void;
  creatingTask: Set<string>;
  taskCreated: Set<string>;
  onPreviewImage: (image: ImageAttachment) => void;
  /** Writes this reply again (the latest reply only) */
  onRegenerate?: () => void;
  /** Sends an edited version of this message (user messages, while Claude isn't replying) */
  onEdit?: (content: string) => void;
}

function MessageBubble({
  message,
  onRegenerate,
  onEdit,
  onPreviewImage,
  onCreateTask,
  creatingTask,
  taskCreated
}: MessageBubbleProps) {
  const { t } = useTranslation('common');
  const isUser = message.role === 'user';
  const [editing, setEditing] = useState(false);
  // The time shown on hover is worked out again each time the message is hovered
  const [now, setNow] = useState(() => Date.now());
  const time = <MessageTime timestamp={message.timestamp} now={now} />;
  // Editing ends when editing is no longer possible (Claude started replying)
  useEffect(() => {
    if (!onEdit) setEditing(false);
  }, [onEdit]);

  if (isUser) {
    const attachments = message.images || [];
    return (
      <div className="group flex flex-col items-end gap-1.5" onMouseEnter={() => setNow(Date.now())}>
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
        {editing ? (
          <MessageEditor
            initial={message.content}
            canBeEmpty={attachments.length > 0}
            onCancel={() => setEditing(false)}
            onSave={(content) => {
              setEditing(false);
              // Saving without changes is the same as cancelling
              if (content !== message.content.trim()) onEdit?.(content);
            }}
          />
        ) : (
          <>
            {/* A message another chat or agent window sent: who sent it, over the message */}
            {message.from && (
              <span className="flex max-w-[85%] items-center gap-1.5 text-xs text-muted-foreground">
                {message.from.kind === 'chat' ? <InsightsIcon className="h-3 w-3 shrink-0" /> : <ClawdIcon className="h-3 w-3 shrink-0" />}
                <span className="truncate">
                  {t(message.from.kind === 'chat' ? 'insights.incoming.fromChat' : 'insights.incoming.fromAgent', {
                    title: message.from.title || message.from.name,
                    name: message.from.name,
                  })}
                </span>
              </span>
            )}
            {/* A message the user sent to another chat or agent window: where it goes */}
            {message.to && (
              <span className="flex max-w-[85%] items-center gap-1.5 text-xs text-muted-foreground">
                {message.to.kind === 'chat' ? <InsightsIcon className="h-3 w-3 shrink-0" /> : <ClawdIcon className="h-3 w-3 shrink-0" />}
                <span className="truncate">
                  {t(message.to.kind === 'chat' ? 'insights.outgoing.toChat' : 'insights.outgoing.toAgent', {
                    title: message.to.title || message.to.name,
                    name: message.to.name,
                  })}
                </span>
              </span>
            )}
            {message.content && (
              <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-muted px-4 py-2.5 text-[0.9375rem] [.dark_&]:bg-[#202020] leading-relaxed text-foreground">
                {message.content}
              </div>
            )}
            {/* Copy and edit appear on hover (edit only while Claude isn't replying) */}
            {(message.content || onEdit) && (
              <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <span className="mr-1 flex items-center">{time}</span>
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground"
                    aria-label={t('insights.editMessage')}
                    title={t('insights.editMessage')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                {message.content && <CopyMessageButton text={message.content} label={t('insights.copyMessage')} />}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // Suggestion lines left in replies saved before they were taken out show as cards only
  const content = stripTaskSuggestions(message.content);

  // Copy (the reply's markdown) and regenerate, before the tools used; the time shows on hover
  const actions = content || onRegenerate ? (
    <div className="flex items-center gap-1">
      {content && <CopyMessageButton text={content} />}
      {onRegenerate && <RegenerateMessageButton onClick={onRegenerate} />}
    </div>
  ) : undefined;
  const hoverTime = <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">{time}</span>;

  return (
    <div className="group space-y-3" onMouseEnter={() => setNow(Date.now())}>
      {content && <MarkdownContent>{content}</MarkdownContent>}
      {/* A slash command that ran without output (a local one such as /compact) */}
      {!content && !message.stopped && !message.toolsUsed?.length && (
        <p className="text-[0.9375rem] text-muted-foreground">{t('insights.slashCommands.noOutput')}</p>
      )}
      {/* A stopped reply says so, under what it had written by then */}
      {message.stopped && (
        <p className="text-[0.9375rem] text-muted-foreground">{t('insights.stoppedByUser')}</p>
      )}

      {message.toolsUsed && message.toolsUsed.length > 0 ? (
        <ToolUsageHistory tools={message.toolsUsed} actions={actions} trailing={hoverTime} />
      ) : (
        <div className="flex items-center gap-2">
          {actions}
          {hoverTime}
        </div>
      )}

      {/* Task suggestion cards */}
      {message.suggestedTasks && message.suggestedTasks.length > 0 && (
        <div className="space-y-3">
          {message.suggestedTasks.map((task, index) => {
            const taskKey = `${message.id}-${index}`;
            const isCreating = creatingTask.has(taskKey);
            const isCreated = taskCreated.has(taskKey);

            return (
              <div key={taskKey} className="rounded-xl border border-border bg-background p-4">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t('insights.suggestedTask')}
                </div>
                <h4 className="mb-1.5 text-[0.9375rem] font-medium text-foreground">
                  {task.title}
                </h4>
                <p className="mb-3 text-sm text-muted-foreground">
                  {task.description}
                </p>
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

/** Workbench's task tools (MCP server "workbench") as Claude Code names them */
const TASK_TOOL_PREFIX = 'mcp__workbench__';

/** The task tool's own name (create_task, move_task, ...), or null for other tools */
const taskToolName = (toolName: string): string | null =>
  toolName.startsWith(TASK_TOOL_PREFIX) ? toolName.slice(TASK_TOOL_PREFIX.length) : null;

/**
 * Messaging other sessions: Workbench's tools (list_sessions, message_chat, message_task) and
 * Claude Code's own (ListAgents, SendMessage)
 */
const MESSAGING_TOOLS = new Set(['list_sessions', 'message_chat', 'message_task', 'ListAgents', 'SendMessage']);

/** The icon of a Workbench tool: messaging, else a task tool (Kanban) */
const workbenchToolIcon = (tool: string): React.ElementType => (MESSAGING_TOOLS.has(tool) ? MessagesIcon : KanbanIcon);

/** A Bash call of the GitHub, GitLab or Graphify CLI: its icon and name (the command is shown as is) */
const cliCall = (toolName: string, input?: string): { icon: React.ElementType; label: string } | null => {
  if (toolName !== 'Bash' || !input) return null;
  const cli = /^\s*(gh|glab|graphify)\s/.exec(input)?.[1];
  if (cli === 'gh') return { icon: GitHubIcon, label: 'GitHub' };
  if (cli === 'glab') return { icon: GitLabIcon, label: 'GitLab' };
  if (cli === 'graphify') return { icon: GraphIcon, label: 'Graphify' };
  return null;
};

/**
 * Icon of an MCP server's tool (mcp__<server>__<tool>): a built-in connector's own icon, the MCP
 * mark for other servers, null for tools that aren't MCP tools
 */
const mcpToolIcon = (toolName: string): React.ElementType | null => {
  const server = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (!server) return null;
  return BUILTIN_CONNECTOR_META.find(({ id }) => id === server.toLowerCase())?.icon ?? McpIcon;
};

/** Tools a read-only turn has too (without the Clawd button) */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ListAgents', 'SendMessage', 'CodebaseGraph']);

/**
 * The MCP servers Workbench gives the chat itself: its task tools, the built-in connectors and the
 * custom ones (named as buildMcpConfig names them). Any other server is the user's own, which only
 * a Clawd turn loads
 */
const useWorkbenchMcpServers = (): Set<string> => {
  const customServers = useSettingsStore((state) => state.settings.mcpConnectors?.customServers);
  return useMemo(() => new Set([
    'workbench',
    ...BUILTIN_CONNECTOR_META.map(({ id }) => id),
    ...(customServers ?? []).map((server) => (server.name || server.id).replace(/[^A-Za-z0-9_-]/g, '_')),
  ]), [customServers]);
};

/**
 * Whether only a turn with the Clawd button could make this call: changing files (other than the
 * project memory), shell commands besides the gh, glab and graphify ones, the user's own MCP
 * servers and every tool a read-only turn doesn't have (subagents, skills, ...)
 */
const isClawdTool = (toolName: string, input: string | undefined, workbenchServers: Set<string>): boolean => {
  const server = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (server) return !workbenchServers.has(server) && !workbenchServers.has(server.toLowerCase());
  if (READ_ONLY_TOOLS.has(toolName) || cliCall(toolName, input)) return false;
  // Saving a project memory (self-improve) is allowed read-only
  if ((toolName === 'Write' || toolName === 'Edit') && input?.replace(/\\/g, '/').includes('.workbench/compeng/')) return false;
  return true;
};

const getToolIcon = (toolName: string) => {
  const taskTool = taskToolName(toolName);
  if (taskTool) return workbenchToolIcon(taskTool);
  if (MESSAGING_TOOLS.has(toolName)) return MessagesIcon;
  const mcpIcon = mcpToolIcon(toolName);
  if (mcpIcon) return mcpIcon;
  switch (toolName) {
    case 'Read':
      return FileText;
    case 'Glob':
      return FolderSearch;
    case 'Grep':
    case 'WebFetch':
    case 'WebSearch':
      return Search;
    case 'CodebaseGraph':
      return GraphIcon;
    case 'Bash':
      return Terminal;
    default:
      return Wrench;
  }
};

// Tool usage history component for showing tools used in completed messages
interface ToolUsageHistoryProps {
  tools: Array<{
    name: string;
    input?: string;
    timestamp: Date;
  }>;
  /** Shown before the toggle (e.g., the copy button) */
  actions?: React.ReactNode;
  /** Shown after the toggle (the message's time) */
  trailing?: React.ReactNode;
}

/** When a message was sent, relative to `now` ("2 hours ago"); the exact date on hover */
function MessageTime({ timestamp, now }: { timestamp: Date | string; now: number }) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()} className="whitespace-nowrap text-[0.6875rem] leading-none text-muted-foreground/70">
      {formatLongRelativeTime(date, now)}
    </time>
  );
}

// How long the copy button shows that the reply was copied
const COPIED_RESET_MS = 1500;

/** Copies an assistant reply's original markdown */
function CopyMessageButton({ text, label: idleLabel }: { text: string; /** Defaults to "Copy response" */ label?: string }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const label = copied ? t('insights.copied') : idleLabel ?? t('insights.copyResponse');
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => setCopied(true), (err) => {
          console.error('Failed to copy the reply:', err);
        });
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground"
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * A sent message being edited in place: the bubble keeps its look and place and its text
 * becomes editable. Enter (or Save) sends it, Escape (or Cancel) leaves it as it was
 */
function MessageEditor({ initial, canBeEmpty, onCancel, onSave }: {
  initial: string;
  /** The message has attachments, so it can be sent without text */
  canBeEmpty: boolean;
  onCancel: () => void;
  onSave: (content: string) => void;
}) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Save turns on once the text changed (and isn't empty, unless the message has attachments)
  const changed = value.trim() !== initial.trim();
  const canSave = changed && (canBeEmpty || value.trim().length > 0);

  // The caret starts at the end of the text
  useEffect(() => {
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <>
      {/* The hidden copy of the text sizes the bubble like the read-only one; the field sits on top */}
      <div className="ml-auto grid max-w-[85%] rounded-xl bg-muted px-4 py-2.5 text-[0.9375rem] [.dark_&]:bg-[#202020] leading-relaxed text-foreground focus-within:shadow-(--shadow-focus)">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre-wrap break-words">
          {`${value}\u200b`}
        </span>
        <textarea
          ref={textareaRef}
          // One column and row: the field takes the hidden text's size, not a default width
          rows={1}
          cols={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              // Enter without changes closes the editor, like Cancel
              e.preventDefault();
              if (canSave) onSave(value.trim());
              else if (!changed) onCancel();
            }
          }}
          aria-label={t('insights.editMessage')}
          className="col-start-1 row-start-1 h-full w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 [font:inherit] text-foreground whitespace-pre-wrap break-words focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-lg px-3 text-sm text-foreground transition-colors hover:bg-nav-hover"
        >
          {t('buttons.cancel')}
        </button>
        <button
          type="button"
          onClick={() => onSave(value.trim())}
          disabled={!canSave}
          className="h-8 rounded-lg bg-foreground px-3 text-sm text-background transition-colors hover:bg-foreground/90 disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground"
        >
          {t('buttons.save')}
        </button>
      </div>
    </>
  );
}

/** Writes the latest reply again */
function RegenerateMessageButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground"
      aria-label={t('insights.regenerate')}
      title={t('insights.regenerate')}
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </button>
  );
}

function ToolUsageHistory({ tools, actions, trailing }: ToolUsageHistoryProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const workbenchServers = useWorkbenchMcpServers();

  if (tools.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-2 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>{t('insights.tools.toolsUsed', { count: tools.length })}</span>
          <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
        </button>
        {trailing}
      </div>

      {expanded && (
        <div className="mt-2 space-y-1 rounded-xl border border-border p-3">
          {tools.map((tool, index) => {
            // gh, glab and graphify calls show as GitHub, GitLab and Graphify, like the task tools show as Kanban steps and the messaging tools as messages
            // Calls only the Clawd button allows show Clawd
            const cli = cliCall(tool.name, tool.input);
            const Icon = isClawdTool(tool.name, tool.input, workbenchServers) ? ClawdIcon : cli?.icon ?? getToolIcon(tool.name);
            const taskTool = taskToolName(tool.name);
            const label = cli?.label
              ?? (taskTool ? t(`insights.taskTools.${taskTool}`, { defaultValue: taskTool }) : tool.name);
            // The whole call, cut with an ellipsis only when it doesn't fit the row
            return (
              <div
                key={`${tool.name}-${index}`}
                className="flex min-w-0 items-center gap-2 text-xs"
                title={tool.input}
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium text-foreground">{label}</span>
                {tool.input && (
                  <span className="min-w-0 truncate text-muted-foreground">
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
  const workbenchServers = useWorkbenchMcpServers();

  // Get friendly name and icon for each tool
  const getToolInfo = (toolName: string) => {
    const taskTool = taskToolName(toolName);
    if (taskTool) return { icon: workbenchToolIcon(taskTool), label: t(`insights.taskTools.${taskTool}`, { defaultValue: taskTool }) };
    // Claude Code's own messaging tools (Workbench's are task tools above)
    if (toolName === 'SendMessage') return { icon: MessagesIcon, label: t('insights.tools.sendMessage') };
    if (toolName === 'ListAgents') return { icon: MessagesIcon, label: t('insights.tools.listAgents') };
    switch (toolName) {
      case 'Read':
        return { icon: FileText, label: t('insights.tools.readingFile') };
      case 'Glob':
        return { icon: FolderSearch, label: t('insights.tools.searchingFiles') };
      case 'Grep':
        return { icon: Search, label: t('insights.tools.searchingCode') };
      case 'CodebaseGraph':
        return { icon: GraphIcon, label: t('insights.tools.searchingGraph') };
      case 'Bash':
        return { icon: Terminal, label: t('insights.tools.runningCommand') };
      case 'WebFetch':
      case 'WebSearch':
        return { icon: Search, label: toolName };
      default:
        return { icon: mcpToolIcon(toolName) ?? Wrench, label: toolName };
    }
  };

  const info = cliCall(name, input) ?? getToolInfo(name);
  // Calls only the Clawd button allows show Clawd
  const { icon: Icon, label } = isClawdTool(name, input, workbenchServers) ? { ...info, icon: ClawdIcon } : info;

  return (
    <span className="flex min-w-0 items-center gap-2" title={input}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      {input && <span className="min-w-0 truncate">{input}</span>}
    </span>
  );
}
