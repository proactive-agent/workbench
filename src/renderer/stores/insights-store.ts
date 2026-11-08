import { create } from 'zustand';
import { stripTaskSuggestions } from '../../shared/utils/task-suggestions';
import type { SessionTarget } from '../lib/session-targets';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatMessage,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsToolUsage,
  InsightsModelConfig,
  TaskMetadata,
  Task,
  ImageAttachment,
  SessionMessageOrigin
} from '../../shared/types';
import { DEFAULT_AGENT_PROFILES } from '../../shared/constants';
import { NEW_CHAT_BROWSER_ID } from '../../shared/types/browser-drawer';
import { useBrowserDrawerStore } from './browser-drawer-store';

interface ToolUsage {
  name: string;
  input?: string;
}

/**
 * A chat's reply in flight: the shown chat's is the store's own fields; other chats' (a project's
 * chats reply at the same time, each in its own Claude Code session) are kept by conversation id
 */
interface ChatRun {
  status: InsightsChatStatus;
  streamingContent: string;
  streamingTasks: NonNullable<InsightsChatMessage['suggestedTasks']>;
  currentTool: ToolUsage | null;
  toolsUsed: InsightsToolUsage[];
}

interface InsightsState {
  // Data
  /** Project whose conversation this store currently holds; events for other projects are ignored */
  projectId: string | null;
  session: InsightsSession | null;
  sessions: InsightsSessionSummary[]; // List of all sessions
  status: InsightsChatStatus;
  pendingMessage: string;
  streamingContent: string; // Accumulates streaming response
  streamingTasks: NonNullable<InsightsChatMessage['suggestedTasks']>; // Accumulates task suggestions during streaming
  currentTool: ToolUsage | null; // Currently executing tool
  toolsUsed: InsightsToolUsage[]; // Tools used during current response
  isLoadingSessions: boolean;
  showArchived: boolean; // Whether to include archived sessions in listings
  pendingImages: ImageAttachment[]; // Images pending attachment to next message
  /** Model and tool choices made before the conversation exists (the conversation's own config wins) */
  draftModelConfig: InsightsModelConfig | undefined;
  /** Replies of chats not on screen, by conversation id, until they end */
  backgroundRuns: Record<string, ChatRun>;
  /**
   * A chat to show on the Claude page (an agent window opened as a chat): the app shows the page,
   * which opens on this chat instead of a new one. `seq` tells requests apart
   */
  openChatRequest: { projectId: string; chatId: string; seq: number } | null;
  /** Asks the Claude page for a new chat, as its New chat button does (the sidebar's Claude item) */
  newChatRequest: number;
  /** The composer's text, kept while the user is on other pages */
  composerText: string;
  /** Where the composer's message goes (a pasted name), for the chat it was chosen in ('new': the New chat page) */
  composerSendTo: { chatKey: string; target: SessionTarget } | null;
  /** Whether the Claude page shows its chat history */
  chatHistoryOpen: boolean;

  // Actions
  setProjectId: (projectId: string) => void;
  setSession: (session: InsightsSession | null) => void;
  setSessions: (sessions: InsightsSessionSummary[]) => void;
  setStatus: (status: InsightsChatStatus) => void;
  setPendingMessage: (message: string) => void;
  addMessage: (message: InsightsChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  appendStreamingContent: (content: string) => void;
  clearStreamingContent: () => void;
  setCurrentTool: (tool: ToolUsage | null) => void;
  addToolUsage: (tool: ToolUsage) => void;
  clearToolsUsed: () => void;
  addStreamingTasks: (tasks: NonNullable<InsightsChatMessage['suggestedTasks']>) => void;
  finalizeStreamingMessage: () => void;
  clearSession: () => void;
  setLoadingSessions: (loading: boolean) => void;
  setShowArchived: (showArchived: boolean) => void;
  setPendingImages: (images: ImageAttachment[]) => void;
  setDraftModelConfig: (config: InsightsModelConfig | undefined) => void;
  requestNewChat: () => void;
  setComposerText: (text: string | ((current: string) => string)) => void;
  /** Show or hide the chat history; `byUser` false (the browser drawer made room): not remembered */
  setChatHistoryOpen: (open: boolean, byUser?: boolean) => void;
  /**
   * Show another chat (null: the New chat page). A reply the shown chat is writing goes on in the
   * background; the chat shown next comes back with its own reply in flight, if it has one
   */
  showSession: (session: InsightsSession | null) => void;
  /** A chat that isn't shown got a stream chunk, status or error */
  updateBackgroundRun: (sessionId: string, update: (run: ChatRun) => ChatRun | null) => void;
}

const initialStatus: InsightsChatStatus = {
  phase: 'idle',
  message: ''
};

/**
 * Id of the conversation shown after the first message of a new chat, until the main process
 * reports the conversation it created for it
 */
export const DRAFT_SESSION_ID = 'draft';

/**
 * The Claude page as the user left it, kept across restarts: each project's last chat (none: the
 * New chat page) and whether the chat history shows
 */
const LAST_CHATS_KEY = 'workbench.claude.lastChats';
const CHAT_HISTORY_KEY = 'workbench.claude.historyOpen';

function readChatHistoryOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_HISTORY_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Each project's last chat, read afresh every time: the app's windows share the storage, and each
 * writes only its own project's entry
 */
let lastChatsFallback: Record<string, string> = {};

function readLastChats(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_CHATS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return lastChatsFallback;
  }
}

/** The chat a project's Claude page showed last (undefined: the New chat page) */
export function lastChatId(projectId: string): string | undefined {
  const id = readLastChats()[projectId];
  return typeof id === 'string' ? id : undefined;
}

function rememberChat(projectId: string, chatId: string | null): void {
  const chats = { ...readLastChats() };
  if (chatId) chats[projectId] = chatId;
  else delete chats[projectId];
  lastChatsFallback = chats;
  try {
    localStorage.setItem(LAST_CHATS_KEY, JSON.stringify(chats));
  } catch {
    // Remembered for this run only
  }
}

const IDLE_RUN: ChatRun = { status: { phase: 'idle', message: '' }, streamingContent: '', streamingTasks: [], currentTool: null, toolsUsed: [] };

/** Whether a reply is being written */
function isReplying(status: InsightsChatStatus): boolean {
  return status.phase === 'thinking' || status.phase === 'streaming';
}

/**
 * A chat's reply after one of its stream chunks, for the shown chat (the store's own fields) and
 * the others alike; null once it ended ('done': the main process saved it in its chat; the shown
 * chat finalizes its message instead)
 */
export function applyRunChunk(run: ChatRun, chunk: InsightsStreamChunk): ChatRun | null {
  switch (chunk.type) {
    case 'text':
      return chunk.content
        ? { ...run, streamingContent: run.streamingContent + chunk.content, currentTool: null, status: { phase: 'streaming', message: 'Receiving response...' } }
        : run;
    case 'tool_start':
      return chunk.tool
        ? {
          ...run,
          currentTool: { name: chunk.tool.name, input: chunk.tool.input },
          toolsUsed: [...run.toolsUsed, { name: chunk.tool.name, input: chunk.tool.input, timestamp: new Date() }],
          status: { phase: 'streaming', message: `Using ${chunk.tool.name}...` },
        }
        : run;
    case 'tool_end':
      return { ...run, currentTool: null };
    case 'task_suggestion':
      return { ...run, currentTool: null, streamingTasks: [...run.streamingTasks, ...(chunk.suggestedTasks ?? [])] };
    case 'done':
      return null;
    case 'error':
      return { ...run, currentTool: null, status: { phase: 'error', error: chunk.error } };
    default:
      return run;
  }
}

/** A chat's reply that isn't shown, after a status from the main process; null once it ended */
export function applyBackgroundStatus(run: ChatRun, status: InsightsChatStatus): ChatRun | null {
  return status.phase === 'complete' || status.phase === 'idle' ? null : { ...run, status };
}

/** The conversations replying now: the shown one and those in the background */
export function replyingSessionIds(state: Pick<InsightsState, 'session' | 'status' | 'backgroundRuns'>): Set<string> {
  const ids = new Set(Object.entries(state.backgroundRuns).filter(([, run]) => isReplying(run.status)).map(([id]) => id));
  if (state.session && state.session.id !== DRAFT_SESSION_ID && isReplying(state.status)) ids.add(state.session.id);
  return ids;
}

/** The chat's id for its own browser (the browser drawer): its conversation, or the New chat page */
export function chatBrowserId(session: InsightsSession | null): string {
  return session && session.id !== DRAFT_SESSION_ID ? session.id : NEW_CHAT_BROWSER_ID;
}

/** The shown chat's model and tool choices: its conversation's, else the ones made before it exists */
export function chatModelConfig(state: Pick<InsightsState, 'session' | 'draftModelConfig'>): InsightsModelConfig | undefined {
  return state.session?.modelConfig ?? state.draftModelConfig;
}

/** A chat's config, or the Balanced profile's model for a chat that has none yet */
export function withDefaultModelConfig(config: InsightsModelConfig | undefined): InsightsModelConfig {
  if (config) return config;
  const balanced = DEFAULT_AGENT_PROFILES.find((profile) => profile.id === 'balanced');
  return { profileId: 'balanced', model: balanced?.model ?? 'sonnet', thinkingLevel: balanced?.thinkingLevel ?? 'medium' };
}

/** A message id that stays unique for messages created in the same millisecond */
function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useInsightsStore = create<InsightsState>((set, _get) => ({
  // Initial state
  projectId: null,
  session: null,
  sessions: [],
  status: initialStatus,
  pendingMessage: '',
  streamingContent: '',
  streamingTasks: [],
  currentTool: null,
  toolsUsed: [],
  isLoadingSessions: false,
  showArchived: false,
  pendingImages: [],
  draftModelConfig: undefined,
  backgroundRuns: {},
  openChatRequest: null,
  newChatRequest: 0,
  composerText: '',
  composerSendTo: null,
  chatHistoryOpen: readChatHistoryOpen(),

  // Actions
  // Switching projects drops the previous project's in-flight state; its reply is still
  // persisted by the main process and shows up when that project's session is loaded again
  setProjectId: (projectId) =>
    set((state) =>
      state.projectId === projectId
        ? state
        : {
            projectId,
            sessions: [],
            status: initialStatus,
            streamingContent: '',
            streamingTasks: [],
            currentTool: null,
            toolsUsed: [],
            backgroundRuns: {},
            // Choices for another project's New chat page, and a recipient among its sessions
            draftModelConfig: undefined,
            composerSendTo: null
          }
    ),

  setSession: (session) => set({ session }),

  setDraftModelConfig: (draftModelConfig) => set({ draftModelConfig }),

  requestNewChat: () => set((state) => ({ newChatRequest: state.newChatRequest + 1 })),

  setComposerText: (text) =>
    set((state) => ({ composerText: typeof text === 'function' ? text(state.composerText) : text })),

  setChatHistoryOpen: (chatHistoryOpen, byUser = true) => {
    set({ chatHistoryOpen });
    // The drawer's own closing is undone by the drawer, not kept as the user's choice
    if (!byUser) return;
    try {
      localStorage.setItem(CHAT_HISTORY_KEY, chatHistoryOpen ? '1' : '0');
    } catch {
      // Remembered only where storage works
    }
  },

  showSession: (session) =>
    set((state) => {
      const runs = { ...state.backgroundRuns };
      const currentId = state.session?.id;
      // The shown chat's reply goes on in the background
      if (currentId && currentId !== DRAFT_SESSION_ID && currentId !== session?.id && isReplying(state.status)) {
        runs[currentId] = {
          status: state.status,
          streamingContent: state.streamingContent,
          streamingTasks: state.streamingTasks,
          currentTool: state.currentTool,
          toolsUsed: state.toolsUsed,
        };
      }
      if (session && currentId === session.id) return { session, backgroundRuns: runs };
      const restored = session ? runs[session.id] : undefined;
      if (session) delete runs[session.id];
      return { session, backgroundRuns: runs, ...(restored ?? IDLE_RUN) };
    }),

  updateBackgroundRun: (sessionId, update) =>
    set((state) => {
      const next = update(state.backgroundRuns[sessionId] ?? IDLE_RUN);
      const runs = { ...state.backgroundRuns };
      if (next) runs[sessionId] = next;
      else delete runs[sessionId];
      return { backgroundRuns: runs };
    }),

  setSessions: (sessions) => set({ sessions }),

  setStatus: (status) => set({ status }),

  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  setShowArchived: (showArchived) => set({ showArchived }),

  setPendingMessage: (message) => set({ pendingMessage: message }),

  addMessage: (message) =>
    set((state) => {
      if (!state.session) {
        // Create new session if none exists
        return {
          session: {
            id: DRAFT_SESSION_ID,
            projectId: '',
            messages: [message],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        };
      }

      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          updatedAt: new Date()
        }
      };
    }),

  updateLastAssistantMessage: (content) =>
    set((state) => {
      if (!state.session || state.session.messages.length === 0) return state;

      const messages = [...state.session.messages];
      const lastIndex = messages.length - 1;
      const lastMessage = messages[lastIndex];

      if (lastMessage.role === 'assistant') {
        messages[lastIndex] = { ...lastMessage, content };
      }

      return {
        session: {
          ...state.session,
          messages,
          updatedAt: new Date()
        }
      };
    }),

  appendStreamingContent: (content) =>
    set((state) => ({
      streamingContent: state.streamingContent + content
    })),

  clearStreamingContent: () => set({ streamingContent: '', streamingTasks: [] }),

  setCurrentTool: (tool) => set({ currentTool: tool }),

  addToolUsage: (tool) =>
    set((state) => ({
      toolsUsed: [
        ...state.toolsUsed,
        {
          name: tool.name,
          input: tool.input,
          timestamp: new Date()
        }
      ]
    })),

  clearToolsUsed: () => set({ toolsUsed: [] }),

  addStreamingTasks: (tasks) =>
    set((state) => ({
      streamingTasks: [...state.streamingTasks, ...tasks]
    })),

  finalizeStreamingMessage: () =>
    set((state) => {
      // Suggestion lines are the cards in suggestedTasks
      const content = stripTaskSuggestions(state.streamingContent);
      const toolsUsed = state.toolsUsed.length > 0 ? [...state.toolsUsed] : undefined;
      const suggestedTasks = state.streamingTasks.length > 0 ? [...state.streamingTasks] : undefined;

      if (!content && !suggestedTasks && !toolsUsed) {
        return { streamingContent: '', streamingTasks: [], toolsUsed: [] };
      }

      const newMessage: InsightsChatMessage = {
        id: newMessageId(),
        role: 'assistant',
        content,
        timestamp: new Date(),
        suggestedTasks,
        toolsUsed
      };

      if (!state.session) {
        return {
          streamingContent: '',
          streamingTasks: [],
          toolsUsed: [],
          session: {
            id: DRAFT_SESSION_ID,
            projectId: '',
            messages: [newMessage],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        };
      }

      return {
        streamingContent: '',
        streamingTasks: [],
        toolsUsed: [],
        session: {
          ...state.session,
          messages: [...state.session.messages, newMessage],
          updatedAt: new Date()
        }
      };
    }),

  clearSession: () =>
    set({
      session: null,
      status: initialStatus,
      pendingMessage: '',
      streamingContent: '',
      streamingTasks: [],
      currentTool: null,
      toolsUsed: [],
      pendingImages: []
    }),

  setPendingImages: (images) => set({ pendingImages: images })
}));

// Helper functions

// The chat shown is the one the page opens on next time (a conversation, or the New chat page;
// not the moment between a new chat's first message and its conversation)
useInsightsStore.subscribe((state, previous) => {
  if (!state.projectId || state.projectId !== previous.projectId) return;
  const id = state.session?.id ?? null;
  if (id === (previous.session?.id ?? null) || id === DRAFT_SESSION_ID) return;
  rememberChat(state.projectId, id);
});

export async function loadInsightsSessions(projectId: string, includeArchived?: boolean): Promise<void> {
  const store = useInsightsStore.getState();
  store.setLoadingSessions(true);

  // Use explicit parameter if provided, otherwise read from store
  const archived = includeArchived ?? store.showArchived;

  try {
    const result = await window.electronAPI.listInsightsSessions(projectId, archived);
    if (result.success && result.data) {
      store.setSessions(result.data);
    } else {
      store.setSessions([]);
    }
  } finally {
    store.setLoadingSessions(false);
  }
}

export async function loadInsightsSession(projectId: string, includeArchived?: boolean): Promise<void> {
  useInsightsStore.getState().setProjectId(projectId);
  const result = await window.electronAPI.getInsightsSession(projectId);
  if (result.success && result.data) {
    useInsightsStore.getState().setSession(result.data);
  } else {
    useInsightsStore.getState().setSession(null);
  }
  // Also load the sessions list
  await loadInsightsSessions(projectId, includeArchived);
}

// Full-size data of recently sent images, kept in memory (not persisted) so they can be
// previewed before the stored copy is available; bounded to the last few images
const SENT_ATTACHMENT_CACHE_LIMIT = 20;
const sentAttachmentCache = new Map<string, string>();

/** Data URL of an image sent during this app session, if still cached */
export function getSentAttachmentDataUrl(attachmentId: string): string | null {
  return sentAttachmentCache.get(attachmentId) ?? null;
}

function cacheSentAttachments(images: ImageAttachment[] | undefined): void {
  for (const image of images ?? []) {
    if (!image.data || !image.mimeType.startsWith('image/')) continue;
    sentAttachmentCache.set(image.id, `data:${image.mimeType};base64,${image.data}`);
    if (sentAttachmentCache.size > SENT_ATTACHMENT_CACHE_LIMIT) {
      const oldest = sentAttachmentCache.keys().next().value;
      if (oldest !== undefined) sentAttachmentCache.delete(oldest);
    }
  }
}

export function sendMessage(
  projectId: string,
  message: string,
  modelConfig?: InsightsModelConfig,
  images?: ImageAttachment[],
  to?: SessionMessageOrigin
): void {
  useInsightsStore.getState().setProjectId(projectId);
  cacheSentAttachments(images);
  const store = useInsightsStore.getState();
  const session = store.session;

  // Add user message to session (strip data to keep memory usage low)
  const displayImages = images?.map(img => ({
    ...img,
    data: undefined // Strip base64 data, keep thumbnails for display
  }));
  const userMessage: InsightsChatMessage = {
    id: newMessageId(),
    role: 'user',
    content: message,
    timestamp: new Date(),
    ...(displayImages && displayImages.length > 0 ? { images: displayImages } : {}),
    ...(to ? { to } : {})
  };
  store.addMessage(userMessage);

  // Clear pending and set status
  store.setPendingMessage('');
  store.setPendingImages([]);
  store.clearStreamingContent();
  store.clearToolsUsed(); // Clear tools from previous response
  store.setStatus({
    phase: 'thinking',
    message: 'Processing your message...'
  });

  // Use provided modelConfig, or fall back to session's config
  const configToUse = modelConfig || session?.modelConfig;

  // Send to main process
  window.electronAPI.sendInsightsMessage(projectId, message, configToUse, images, to);
}

/**
 * Stop the reply Claude is writing. The main process ends the reply with what was written so far;
 * when nothing was running there (e.g. it just finished), the chat is settled here instead
 */
export async function stopMessage(projectId: string): Promise<void> {
  // The shown chat's reply (other chats' go on); before the conversation exists, the open one's
  const sessionId = savedSessionId(useInsightsStore.getState().session);
  const stopped = await window.electronAPI.stopInsightsMessage(projectId, sessionId).catch(() => false);
  if (stopped) return;
  const store = useInsightsStore.getState();
  if (store.status.phase !== 'thinking' && store.status.phase !== 'streaming') return;
  store.setCurrentTool(null);
  store.finalizeStreamingMessage();
  store.setStatus({ phase: 'idle', message: '' });
}

/**
 * Open the Claude page: it always starts on a new chat, past conversations stay in the history.
 * A reply still being written keeps its conversation on screen, so it doesn't stream into the
 * new chat
 */
/** The shown conversation's id, so regenerate and edit act on it (none before it is created) */
function savedSessionId(session: InsightsSession | null): string | undefined {
  return session && session.id !== DRAFT_SESSION_ID ? session.id : undefined;
}

/**
 * Write the latest reply again: it leaves the chat and a new one streams in its place
 */
export function regenerateMessage(projectId: string, modelConfig?: InsightsModelConfig): void {
  const store = useInsightsStore.getState();
  const session = store.session;
  if (session) {
    const messages = [...session.messages];
    while (messages.at(-1)?.role === 'assistant') messages.pop();
    store.setSession({ ...session, messages });
  }
  store.clearStreamingContent();
  store.clearToolsUsed();
  store.setCurrentTool(null);
  store.setStatus({ phase: 'thinking', message: 'Processing your message...' });
  window.electronAPI.regenerateInsightsMessage(projectId, modelConfig ?? session?.modelConfig, savedSessionId(session));
}

/**
 * Send an edited message: the chat from that message on is replaced by the edited message,
 * and its reply streams in
 */
export function editMessage(projectId: string, messageId: string, content: string, modelConfig?: InsightsModelConfig): void {
  const store = useInsightsStore.getState();
  const session = store.session;
  const index = session?.messages.findIndex((m) => m.id === messageId) ?? -1;
  if (!session || index < 0) return;
  store.setSession({
    ...session,
    messages: [...session.messages.slice(0, index), { ...session.messages[index], content, timestamp: new Date() }],
  });
  store.clearStreamingContent();
  store.clearToolsUsed();
  store.setCurrentTool(null);
  store.setStatus({ phase: 'thinking', message: 'Processing your message...' });
  window.electronAPI.editInsightsMessage(projectId, messageId, content, modelConfig ?? session.modelConfig, savedSessionId(session));
}

export async function openInsightsPage(projectId: string, includeArchived?: boolean): Promise<void> {
  const sameProject = useInsightsStore.getState().projectId === projectId;
  useInsightsStore.getState().setProjectId(projectId);
  // Opened for a chat (an agent window opened as a chat): that chat
  const request = useInsightsStore.getState().openChatRequest;
  if (request?.projectId === projectId) {
    useInsightsStore.setState({ openChatRequest: null });
    await loadInsightsSessions(projectId, includeArchived);
    await switchSession(projectId, request.chatId);
    return;
  }
  // The page as it was left: the chat it showed last, or the New chat page (with its choices)
  const last = lastChatId(projectId) ?? null;
  const shown = useInsightsStore.getState().session;
  if (sameProject && (shown?.id ?? null) === last) {
    await loadInsightsSessions(projectId, includeArchived);
    return;
  }
  // A new chat's first message is still on its way to becoming a conversation
  if (sameProject && shown?.id === DRAFT_SESSION_ID) {
    await loadInsightsSessions(projectId, includeArchived);
    return;
  }
  if (last) {
    const [, result] = await Promise.all([
      loadInsightsSessions(projectId, includeArchived),
      window.electronAPI.switchInsightsSession(projectId, last),
    ]);
    if (result.success && result.data) {
      useInsightsStore.getState().showSession(result.data);
      return;
    }
    // Gone (deleted): a new chat, the history just listed
    await newSession(projectId, { listChats: false });
    return;
  }
  // No chat to go back to yet
  await newSession(projectId);
}

/** Requests to show a chat made so far (App tells a new one by its number) */
let openChatRequests = 0;

/**
 * Open an agent window's Claude Code session as a chat and show it on the Claude page. Resolves
 * with the error code when it can't (an OpenWindowAsChatError)
 */
export async function openWindowAsChat(projectId: string, terminalId: string): Promise<string | null> {
  const result = await window.electronAPI.openWindowAsChat(projectId, terminalId);
  if (!result.success || !result.data) return result.error ?? 'failed';
  // Every request gets a number of its own (a used one is cleared, so it can't count from it)
  const seq = ++openChatRequests;
  // The app shows the Claude page, which opens on the chat
  useInsightsStore.setState({ openChatRequest: { projectId, chatId: result.data, seq } });
  return null;
}

export async function newSession(projectId: string, options: { listChats?: boolean } = {}): Promise<void> {
  // The conversation is created when the first message is sent
  const result = await window.electronAPI.newInsightsSession(projectId);
  if (result.success) {
    // A fresh conversation starts clean; a reply the previous chat is writing goes on in it
    useInsightsStore.getState().showSession(null);
    // Reload sessions list (unless the caller just did)
    if (options.listChats !== false) await loadInsightsSessions(projectId);
  }
}

export async function switchSession(projectId: string, sessionId: string): Promise<void> {
  const result = await window.electronAPI.switchInsightsSession(projectId, sessionId);
  if (result.success && result.data) {
    // The chat comes with its own reply in flight, if it is writing one (the one left goes on)
    useInsightsStore.getState().showSession(result.data);
  }
}

export async function deleteSession(projectId: string, sessionId: string, includeArchived?: boolean): Promise<boolean> {
  const result = await window.electronAPI.deleteInsightsSession(projectId, sessionId);
  if (result.success) {
    // Deleting the open chat leads to a new chat, without the deleted chat's reply or error
    const store = useInsightsStore.getState();
    if (store.session?.id === sessionId) {
      store.clearStreamingContent();
      store.clearToolsUsed();
      store.setCurrentTool(null);
      store.setStatus({ phase: 'idle', message: '' });
    }
    // Its reply was stopped with it
    store.updateBackgroundRun(sessionId, () => null);
    // Reload sessions list and current session
    await loadInsightsSession(projectId, includeArchived);
    return true;
  }
  return false;
}

export async function renameSession(projectId: string, sessionId: string, newTitle: string): Promise<boolean> {
  const result = await window.electronAPI.renameInsightsSession(projectId, sessionId, newTitle);
  if (result.success) {
    // Reload sessions list to reflect the change
    await loadInsightsSessions(projectId);
    return true;
  }
  return false;
}

export async function unarchiveSession(projectId: string, sessionId: string): Promise<boolean> {
  const result = await window.electronAPI.unarchiveInsightsSession(projectId, sessionId);
  return result.success;
}

/**
 * Change the shown chat's model and tool choices: applied at once (they are sent with the next
 * message, before the conversation exists on disk) and saved with its conversation
 */
export async function changeChatModelConfig(projectId: string, config: InsightsModelConfig): Promise<void> {
  const store = useInsightsStore.getState();
  store.setDraftModelConfig(config);
  const sessionId = savedSessionId(store.session);
  if (sessionId) await updateModelConfig(projectId, sessionId, config);
}

export async function updateModelConfig(projectId: string, sessionId: string, modelConfig: InsightsModelConfig): Promise<boolean> {
  // Update local session state first: a brand-new session isn't on disk until its first message,
  // so persisting can fail while the selection must still apply (it is sent with the next message)
  const store = useInsightsStore.getState();
  if (store.session?.id === sessionId) {
    store.setSession({
      ...store.session,
      modelConfig,
      updatedAt: new Date()
    });
  }
  const result = await window.electronAPI.updateInsightsModelConfig(projectId, sessionId, modelConfig);
  if (result.success) {
    // Reload sessions list to reflect the change
    await loadInsightsSessions(projectId);
    return true;
  }
  return false;
}

export async function createTaskFromSuggestion(
  projectId: string,
  title: string,
  description: string,
  metadata?: TaskMetadata
): Promise<Task | null> {
  const result = await window.electronAPI.createTaskFromInsights(
    projectId,
    title,
    description,
    metadata
  );

  if (result.success && result.data) {
    return result.data;
  }
  return null;
}

// IPC listener setup - called once at app start (useIpcListeners) so a reply that finishes
// or fails while the Insights page is not mounted still updates the store
export function setupInsightsListeners(): () => void {
  const store = useInsightsStore.getState;
  const isCurrentProject = (projectId: string) => projectId === store().projectId;
  /**
   * Whether an event of this chat goes to the chat on screen; the others' replies go on in the
   * background. A new chat's first reply belongs to the shown draft until its conversation arrives
   */
  // Chats whose replies went on in the background: their last events (a status after the 'done'
  // chunk that ended the background run) never go to the shown draft
  const repliedElsewhere = new Set<string>();
  const isShown = (sessionId: string | undefined) => {
    const shown = store().session?.id;
    if (!sessionId || sessionId === shown) return true;
    if (store().backgroundRuns[sessionId]) repliedElsewhere.add(sessionId);
    if (repliedElsewhere.has(sessionId)) return false;
    return shown === DRAFT_SESSION_ID && !store().sessions.some((s) => s.id === sessionId);
  };

  // Listen for streaming chunks
  const unsubStreamChunk = window.electronAPI.onInsightsStreamChunk(
    (projectId, chunk: InsightsStreamChunk) => {
      if (!isCurrentProject(projectId)) return;
      // Another chat's reply goes on where it is (saved in its chat when it ends)
      if (!isShown(chunk.sessionId)) {
        store().updateBackgroundRun(chunk.sessionId!, (run) => applyRunChunk(run, chunk));
        return;
      }
      if (chunk.type === 'done') {
        // Finalize any remaining content
        store().setCurrentTool(null);
        store().finalizeStreamingMessage();
        store().setStatus({
          phase: 'complete',
          message: ''
        });
        return;
      }
      // The same steps as a chat replying in the background, on the store's own fields
      const state = store();
      const run: ChatRun = {
        status: state.status,
        streamingContent: state.streamingContent,
        streamingTasks: state.streamingTasks,
        currentTool: state.currentTool,
        toolsUsed: state.toolsUsed,
      };
      const next = applyRunChunk(run, chunk);
      if (next && next !== run) useInsightsStore.setState(next);
    }
  );

  // Listen for status updates
  const unsubStatus = window.electronAPI.onInsightsStatus((projectId, status, sessionId) => {
    if (!isCurrentProject(projectId)) return;
    if (!isShown(sessionId)) {
      store().updateBackgroundRun(sessionId!, (run) => applyBackgroundStatus(run, status));
      return;
    }
    store().setStatus(status);
  });

  // Listen for errors
  const unsubError = window.electronAPI.onInsightsError((projectId, error, sessionId) => {
    if (!isCurrentProject(projectId)) return;
    if (!isShown(sessionId)) {
      store().updateBackgroundRun(sessionId!, (run) => ({ ...run, currentTool: null, status: { phase: 'error', error } }));
      return;
    }
    store().setStatus({
      phase: 'error',
      error
    });
  });

  // Listen for session updates (e.g., after assistant message saved with auto-generated title)
  const unsubSessionUpdated = window.electronAPI.onInsightsSessionUpdated(
    (projectId, session: InsightsSession) => {
      // Another project's chat (e.g. open in another window) leaves this one alone
      if (!isCurrentProject(projectId)) return;
      // Update current session if it matches, or take the conversation a new chat's first
      // message created
      const currentSession = store().session;
      const createdForDraft = currentSession?.id === DRAFT_SESSION_ID &&
        session.messages[0]?.content === currentSession.messages[0]?.content;
      if (currentSession?.id === session.id || createdForDraft) {
        // The New chat page's browser drawer (and browser) belong to the conversation now
        if (createdForDraft) useBrowserDrawerStore.getState().adoptChatView(projectId, session.id);
        store().setSession(session);
      }
      // Also refresh sessions list for sidebar
      loadInsightsSessions(session.projectId).catch((err) => {
        console.error('Failed to refresh sessions list after update:', err);
      });
    }
  );

  // Return cleanup function
  return () => {
    unsubStreamChunk();
    unsubStatus();
    unsubError();
    unsubSessionUpdated();
  };
}
