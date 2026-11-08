import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatMessage,
  InsightsModelConfig,
  ImageAttachment,
  SessionMessageOrigin
} from '../shared/types';
import { MAX_IMAGES_PER_TASK } from '../shared/constants';
import { InsightsConfig } from './insights/config';
import { InsightsPaths } from './insights/paths';
import { SessionStorage } from './insights/session-storage';
import { SessionManager } from './insights/session-manager';
import { InsightsExecutor } from './insights/insights-executor';
import type { InsightsSessionPlan } from './insights/claude-code-runner';
import { browserDrawer } from './browser-drawer';
import { setChatSource, type ChatDelivery, type ChatEntry } from './session-messaging/directory';
import { incomingMessageText, outgoingMessageText } from './session-messaging/tools';
import { readTranscriptAsChat } from './insights/session-import';
import { ensureAgentWindowRunning } from './session-messaging/agent-windows';

/** Messages from other sessions a chat answers in a row before it waits for the user */
const MAX_AUTO_REPLIES = 5;

/**
 * What a chat's Claude reads for a message: a message from another session is marked as one, a
 * message the user sent to another chat or agent window says where it goes
 */
function messageText(message: Pick<InsightsChatMessage, 'content' | 'from' | 'to'>): string {
  if (message.from) return incomingMessageText(message.from, message.content);
  return message.to ? outgoingMessageText(message.to, message.content) : message.content;
}

/** A message id that stays unique for messages created in the same millisecond */
function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The Claude Code session a new message runs in, from the reply before it:
 * - that reply is the session's latest point: resume the session
 * - an earlier reply of the session (an edit or regenerate dropped what came after it): fork the
 *   session there, so the dropped turns stay out of it and the original session is kept
 * - no reply before it (the first message), or a reply without a session (a stopped one, or one
 *   from before chats had sessions): a new session, with the conversation folded into its prompt
 */
export function planClaudeSession(session: InsightsSession): InsightsSessionPlan {
  const previous = session.messages.at(-2);
  const ref = previous?.role === 'assistant' ? previous.claudeRef : undefined;
  if (!ref) return { mode: 'new' };
  const head = session.claudeHead;
  if (head?.sessionId === ref.sessionId && head.messageUuid === ref.messageUuid) {
    return { mode: 'resume', sessionId: ref.sessionId, profileId: ref.profileId };
  }
  return { mode: 'fork', sessionId: ref.sessionId, atMessageUuid: ref.messageUuid, profileId: ref.profileId };
}

/**
 * Service for AI-powered codebase insights chat
 *
 * This service coordinates between multiple specialized modules:
 * - InsightsConfig: Manages configuration and environment
 * - InsightsPaths: Provides consistent path resolution
 * - SessionStorage: Handles filesystem persistence
 * - SessionManager: Manages session lifecycle and cache
 * - InsightsExecutor: Executes Python insights runner
 */
class InsightsService extends EventEmitter {
  private config: InsightsConfig;
  private paths: InsightsPaths;
  private storage: SessionStorage;
  private sessionManager: SessionManager;
  private executor: InsightsExecutor;
  /** Messages from other sessions waiting for a chat's reply to end (by project and chat) */
  private incoming = new Map<string, Array<{ from: SessionMessageOrigin; text: string }>>();
  /**
   * How many messages from other sessions each chat answered since the user last wrote there: two
   * chats answering each other would otherwise go on without end
   */
  private autoReplies = new Map<string, number>();

  constructor() {
    super();

    // Initialize modules
    this.config = new InsightsConfig();
    this.paths = new InsightsPaths();
    this.storage = new SessionStorage(this.paths);
    this.sessionManager = new SessionManager(this.storage, this.paths);
    this.executor = new InsightsExecutor();

    // Forward executor events
    this.executor.on('status', (projectId, status, sessionId) => {
      this.emit('status', projectId, status, sessionId);
    });
    this.executor.on('stream-chunk', (projectId, chunk) => {
      this.emit('stream-chunk', projectId, chunk);
    });
    this.executor.on('error', (projectId, error, sessionId) => {
      this.emit('error', projectId, error, sessionId);
    });
    this.executor.on('tasks-changed', (projectId) => {
      this.emit('tasks-changed', projectId);
    });
    this.executor.on('sdk-rate-limit', (info) => {
      this.emit('sdk-rate-limit', info);
    });

    // The project's other chats and agent windows message chats through Workbench
    setChatSource({
      list: (projectId, projectPath) => this.listChats(projectId, projectPath),
      deliver: (projectId, projectPath, chatId, from, text) => this.receiveMessage(projectId, projectPath, chatId, from, text),
    });
  }

  /** The project's chats, for the messaging tools */
  private listChats(projectId: string, projectPath: string): ChatEntry[] {
    return this.listSessions(projectPath).map((summary) => ({
      chatId: summary.id,
      title: summary.title,
      replying: this.executor.isSessionActive(projectId, summary.id),
    }));
  }

  /**
   * A chat as the app holds it: the open chat's own object (so the next message the user sends
   * keeps what is added here), any other from disk
   */
  private chatById(projectId: string, projectPath: string, chatId: string): InsightsSession | null {
    const cached = this.sessionManager.getCachedSession(projectId);
    if (cached?.id === chatId) return cached;
    return this.storage.loadSessionById(projectPath, chatId);
  }

  /**
   * A message from another of the project's chats or agent windows: shown in the chat, marked
   * with its sender, and answered by a reply of the chat's own (once the reply it is writing ends)
   */
  async receiveMessage(
    projectId: string,
    projectPath: string,
    chatId: string,
    from: SessionMessageOrigin,
    text: string
  ): Promise<ChatDelivery> {
    const session = this.chatById(projectId, projectPath, chatId);
    if (!session || session.archivedAt) return { status: 'notFound' };
    // A chat writing a reply takes the message once it ends (its reply's save would drop one
    // added meanwhile)
    if (this.executor.isSessionActive(projectId, chatId)) {
      const key = `${projectId}\u0000${chatId}`;
      this.incoming.set(key, [...(this.incoming.get(key) ?? []), { from, text }]);
      return { status: 'queued' };
    }
    return this.takeIncoming(projectId, projectPath, chatId, from, text);
  }

  /**
   * A message from another session for a chat that isn't replying: answered, or only shown once
   * the chat answered MAX_AUTO_REPLIES in a row (the user decides how it goes on)
   */
  private takeIncoming(projectId: string, projectPath: string, chatId: string, from: SessionMessageOrigin, text: string): ChatDelivery {
    const session = this.chatById(projectId, projectPath, chatId);
    if (!session || session.archivedAt) return { status: 'notFound' };
    const key = `${projectId}\u0000${chatId}`;
    const answered = this.autoReplies.get(key) ?? 0;
    if (answered >= MAX_AUTO_REPLIES) {
      session.messages.push({ id: newMessageId(), role: 'user', content: text, timestamp: new Date(), from });
      session.updatedAt = new Date();
      if (this.sessionManager.saveReply(projectId, projectPath, session)) this.emit('session-updated', projectId, session);
      return { status: 'held', answered };
    }
    this.autoReplies.set(key, answered + 1);
    void this.answerIncoming(projectId, projectPath, session, from, text);
    return { status: 'started' };
  }

  private async answerIncoming(projectId: string, projectPath: string, session: InsightsSession, from: SessionMessageOrigin, text: string): Promise<void> {
    session.messages.push({ id: newMessageId(), role: 'user', content: text, timestamp: new Date(), from });
    session.updatedAt = new Date();
    // Saved without making it the open chat
    if (!this.sessionManager.saveReply(projectId, projectPath, session)) return;
    this.emit('session-updated', projectId, session);
    await this.reply(projectId, projectPath, session, incomingMessageText(from, text), session.modelConfig);
  }

  /**
   * Open an agent window's Claude Code session as a chat: the chat opened from it before (with
   * what was said since in the window), or a new one, made the open chat. Its next message resumes
   * the session. Returns the chat's id, or null when the session has no conversation to show
   */
  async openSessionAsChat(
    projectId: string,
    projectPath: string,
    source: { sessionId: string; transcriptPath: string; profileId?: string }
  ): Promise<string | null> {
    const { messages, head } = await readTranscriptAsChat(source.transcriptPath, source.sessionId, source.profileId);
    if (messages.length === 0) return null;
    // The chat opened from this session before (the latest, archived ones too)
    const summary = this.listSessions(projectPath, true)
      .filter((candidate) => candidate.fromSessionId === source.sessionId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    const existing = summary ? this.chatById(projectId, projectPath, summary.id) : null;
    if (existing?.archivedAt) this.unarchiveSession(projectPath, existing.id);
    // A chat replying keeps what it holds; it is only shown
    if (existing && this.executor.isSessionActive(projectId, existing.id)) {
      this.sessionManager.switchSession(projectId, projectPath, existing.id);
      return existing.id;
    }
    // It takes what was said in the window since: the transcript after the chat's own last point.
    // A chat that went on in another session (a stop, an edit) keeps its conversation, and the
    // window's opens as a new chat
    const since = existing?.claudeHead?.sessionId === source.sessionId
      ? messages.findIndex((message) => message.claudeRef?.messageUuid === existing.claudeHead?.messageUuid)
      : -1;
    if (existing && since >= 0) {
      existing.messages.push(...messages.slice(since + 1));
      existing.claudeHead = head;
      existing.updatedAt = new Date();
      this.storage.saveSession(projectPath, existing);
      this.sessionManager.switchSession(projectId, projectPath, existing.id);
      this.emit('session-updated', projectId, existing);
      return existing.id;
    }
    const session = this.sessionManager.createNewSession(projectId, projectPath);
    const firstPrompt = messages.find((message) => message.role === 'user');
    if (firstPrompt) session.title = this.storage.generateTitle(firstPrompt.content);
    session.messages = messages;
    session.claudeHead = head;
    session.fromSessionId = source.sessionId;
    session.updatedAt = new Date();
    this.storage.saveSession(projectPath, session);
    this.sessionManager.switchSession(projectId, projectPath, session.id);
    this.emit('session-updated', projectId, session);
    return session.id;
  }

  /**
   * The messages waiting for a chat, once its reply ended: the next one is answered (those over the
   * limit only shown), the rest wait for that reply
   */
  private answerQueued(projectId: string, projectPath: string, chatId: string): void {
    const key = `${projectId}\u0000${chatId}`;
    const queue = this.incoming.get(key);
    while (queue?.length && !this.executor.isSessionActive(projectId, chatId)) {
      const next = queue.shift()!;
      if (this.takeIncoming(projectId, projectPath, chatId, next.from, next.text).status === 'started') break;
    }
    if (queue && queue.length === 0) this.incoming.delete(key);
  }

  /**
   * Configure paths for Python and workbench source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.config.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * Load current session from disk or cache
   */
  loadSession(projectId: string, projectPath: string): InsightsSession | null {
    return this.sessionManager.loadSession(projectId, projectPath);
  }

  /**
   * List all sessions for a project
   */
  listSessions(projectPath: string, includeArchived = false): InsightsSessionSummary[] {
    return this.sessionManager.listSessions(projectPath, includeArchived);
  }

  /**
   * Create a new session
   */
  createNewSession(projectId: string, projectPath: string): InsightsSession {
    return this.sessionManager.createNewSession(projectId, projectPath);
  }

  /**
   * Open a new chat; its conversation is created when the first message is sent
   */
  startNewChat(projectId: string, projectPath: string): void {
    // A reply still being written goes on: it is saved in its own chat
    this.sessionManager.startNewChat(projectId, projectPath);
  }

  /**
   * Switch to a different session
   */
  switchSession(projectId: string, projectPath: string, sessionId: string): InsightsSession | null {
    // Other chats' replies go on while the user is elsewhere (each is saved in its own chat)
    return this.sessionManager.switchSession(projectId, projectPath, sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(projectId: string, projectPath: string, sessionId: string): boolean {
    const deleted = this.sessionManager.deleteSession(projectId, projectPath, sessionId);
    if (deleted) {
      this.executor.cancelSession(projectId, sessionId);
      // The chat's own browser goes with it
      void browserDrawer.chatBrowsers.closeChats(projectId, [sessionId]);
    }
    return deleted;
  }

  /**
   * Archive a session
   */
  archiveSession(projectId: string, projectPath: string, sessionId: string): boolean {
    return this.sessionManager.archiveSession(projectId, projectPath, sessionId);
  }

  /**
   * Unarchive a session
   */
  unarchiveSession(projectPath: string, sessionId: string): boolean {
    return this.sessionManager.unarchiveSession(projectPath, sessionId);
  }

  /**
   * Delete multiple sessions
   */
  deleteSessions(projectId: string, projectPath: string, sessionIds: string[]): { deletedIds: string[]; failedIds: string[] } {
    const result = this.sessionManager.deleteSessions(projectId, projectPath, sessionIds);
    for (const id of result.deletedIds) this.executor.cancelSession(projectId, id);
    void browserDrawer.chatBrowsers.closeChats(projectId, result.deletedIds);
    return result;
  }

  /**
   * Archive multiple sessions
   */
  archiveSessions(projectId: string, projectPath: string, sessionIds: string[]): { archivedIds: string[]; failedIds: string[] } {
    return this.sessionManager.archiveSessions(projectId, projectPath, sessionIds);
  }

  /**
   * Rename a session
   */
  renameSession(projectPath: string, sessionId: string, newTitle: string): boolean {
    return this.sessionManager.renameSession(projectPath, sessionId, newTitle);
  }

  /**
   * Clear current session (delete messages but keep the session)
   */
  clearSession(projectId: string, projectPath: string): void {
    this.sessionManager.clearSession(projectId, projectPath);
  }

  /**
   * Stop the reply a chat is writing (without an id: the open chat's); returns false when it has none
   */
  stopMessage(projectId: string, sessionId?: string): boolean {
    const id = sessionId ?? this.sessionManager.getCachedSession(projectId)?.id;
    return id ? this.executor.cancelSession(projectId, id) : false;
  }

  /**
   * The project's open conversation, when it is the one the user sees: a chat shown in the app
   * but not open here (or gone) is opened first, so regenerate and edit act on what is shown
   */
  private loadShownSession(projectId: string, projectPath: string, sessionId?: string): InsightsSession | null {
    const session = this.sessionManager.loadSession(projectId, projectPath);
    if (!sessionId || session?.id === sessionId) return session;
    return this.sessionManager.switchSession(projectId, projectPath, sessionId);
  }

  /**
   * Regenerate or edit found nothing to act on: the chat shows its saved conversation again and
   * says why, instead of waiting for a reply that never comes
   */
  private failTurn(projectId: string, session: InsightsSession | null, error: string, sessionId?: string): void {
    if (session) this.emit('session-updated', projectId, session);
    this.emit('error', projectId, error, session?.id ?? sessionId);
  }

  /**
   * Send a message and get AI response
   */
  async sendMessage(
    projectId: string,
    projectPath: string,
    message: string,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    to?: SessionMessageOrigin
  ): Promise<void> {
    // Load or create session
    let session = this.sessionManager.loadSession(projectId, projectPath);
    // The user wrote: the chat answers other sessions again
    if (session) this.autoReplies.delete(`${projectId}\u0000${session.id}`);
    // The chat's own reply stops (other chats' go on)
    if (session) this.executor.cancelSession(projectId, session.id);
    if (!session) {
      session = this.sessionManager.createNewSession(projectId, projectPath);
      // A browser opened on the New chat page belongs to the conversation its first message made
      browserDrawer.chatBrowsers.adopt(projectId, session.id);
    }

    // Auto-generate title from first user message if still default
    if (session.messages.length === 0 && session.title === 'New Conversation') {
      session.title = this.storage.generateTitle(message);
    }

    // Guard: cap images to MAX_IMAGES_PER_TASK
    if (images && images.length > MAX_IMAGES_PER_TASK) {
      images = images.slice(0, MAX_IMAGES_PER_TASK);
    }

    // Full-size images go to the session's attachments directory (so they can be previewed
    // later); the session JSON keeps only the thumbnail and the stored file's path
    const sessionId = session.id;
    const persistImages = images?.map(img => ({
      ...img,
      path: this.storeAttachment(projectPath, sessionId, img),
      data: undefined
    }));
    const userMessage: InsightsChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: message,
      timestamp: new Date(),
      images: persistImages && persistImages.length > 0 ? persistImages : undefined,
      ...(to ? { to } : {})
    };
    session.messages.push(userMessage);
    if (modelConfig) session.modelConfig = modelConfig;
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);
    // The chat (and the history list) learn the conversation now, a new one included
    this.emit('session-updated', projectId, session);


    await this.reply(projectId, projectPath, session, messageText(userMessage), modelConfig, images);
  }

  /**
   * Write the latest reply again: the conversation's last reply is replaced by a new answer to
   * the message before it, with that message's attachments
   */
  async regenerate(projectId: string, projectPath: string, modelConfig?: InsightsModelConfig, sessionId?: string): Promise<void> {
    const session = this.loadShownSession(projectId, projectPath, sessionId);
    if (session) this.executor.cancelSession(projectId, session.id);
    if (session) this.autoReplies.delete(`${projectId}\u0000${session.id}`);
    while (session?.messages.at(-1)?.role === 'assistant') session.messages.pop();
    const userMessage = session?.messages.at(-1);
    if (!session || !userMessage) {
      this.failTurn(projectId, session, 'There is no message to answer again', sessionId);
      return;
    }

    if (modelConfig) session.modelConfig = modelConfig;
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);
    this.emit('session-updated', projectId, session);

    await this.reply(projectId, projectPath, session, messageText(userMessage), modelConfig, this.loadAttachments(projectPath, userMessage));
  }

  /**
   * Send an edited message: the conversation from that message on is dropped, and the edited
   * text (with the message's attachments) is sent in its place
   */
  async editMessage(
    projectId: string,
    projectPath: string,
    messageId: string,
    content: string,
    modelConfig?: InsightsModelConfig,
    sessionId?: string
  ): Promise<void> {
    const session = this.loadShownSession(projectId, projectPath, sessionId);
    if (session) this.executor.cancelSession(projectId, session.id);
    if (session) this.autoReplies.delete(`${projectId}\u0000${session.id}`);
    const index = session?.messages.findIndex((m) => m.id === messageId && m.role === 'user') ?? -1;
    if (!session || index < 0) {
      this.failTurn(projectId, session, 'The edited message is no longer in this chat', sessionId);
      return;
    }
    const original = session.messages[index];

    // A title made from the first message follows its edit; a title the user gave stays
    if (index === 0 && session.title === this.storage.generateTitle(original.content)) {
      session.title = this.storage.generateTitle(content);
    }
    // An edited message is the user's own, whoever sent it first
    const userMessage: InsightsChatMessage = {
      ...original,
      id: newMessageId(),
      content,
      timestamp: new Date(),
      from: undefined
    };
    session.messages = [...session.messages.slice(0, index), userMessage];
    if (modelConfig) session.modelConfig = modelConfig;
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);
    this.emit('session-updated', projectId, session);

    await this.reply(projectId, projectPath, session, messageText(userMessage), modelConfig, this.loadAttachments(projectPath, userMessage));
  }

  /**
   * A sent message's attachments with their data, read back from the attachments directory
   */
  private loadAttachments(projectPath: string, message: InsightsChatMessage): ImageAttachment[] | undefined {
    const images = (message.images ?? []).flatMap((img) => {
      const data = img.path ? this.readAttachmentData(projectPath, img.path) : null;
      return data ? [{ ...img, data }] : [];
    });
    return images.length > 0 ? images : undefined;
  }

  /**
   * Run Claude Code for the conversation's last message and save its reply
   */
  private async reply(
    projectId: string,
    projectPath: string,
    session: InsightsSession,
    message: string,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[]
  ): Promise<void> {
    // A message to an agent window that isn't running (closed, or not started since the app
    // started): it opens first, so list_sessions finds it running. Also on a regenerate or an edit
    const to = session.messages.at(-1)?.to;
    if (to?.kind === 'agent') await ensureAgentWindowRunning(projectPath, to.name).catch(() => false);

    // The conversation before this message, for a turn that starts a new Claude Code session
    // (replies stopped before any text are left out; the message itself is sent separately, with
    // its attachments)
    const messages = session.messages
      .slice(0, -1)
      .filter((m) => !(m.role === 'assistant' && m.stopped && !m.content));
    const conversationHistory = messages.map((m) => {
      const imageCount = m.images?.length ?? 0;
      const imageNotation = imageCount > 0 && m.role === 'user'
        ? `\n[User previously attached ${imageCount} file(s) - not visible in this context]`
        : '';
      return { role: m.role, content: messageText(m) + imageNotation };
    });

    // Use provided modelConfig or fall back to session's config
    const configToUse = modelConfig || session.modelConfig;

    let answeredFully = false;
    try {
      const result = await this.executor.execute(
        projectId,
        projectPath,
        message,
        conversationHistory,
        configToUse,
        images,
        { session: planClaudeSession(session), title: session.title, chatSessionId: session.id }
      );

      if (result.replaced) return;
      // A reply the user stopped leaves the messages other sessions sent waiting (Stop must not
      // start the next reply); they are answered after the chat's next reply
      answeredFully = !result.stopped;

      // A reply that ended with nothing leaves no message; a stopped one says it was stopped
      const isEmpty = !result.fullResponse && result.toolsUsed.length === 0 && !result.suggestedTasks;
      if (isEmpty && !result.stopped) return;

      // Add assistant message to session
      const assistantMessage: InsightsChatMessage = {
        id: newMessageId(),
        role: 'assistant',
        content: result.fullResponse,
        timestamp: new Date(),
        suggestedTasks: result.suggestedTasks,
        toolsUsed: result.toolsUsed.length > 0 ? result.toolsUsed : undefined,
        stopped: result.stopped || undefined,
        // Where the next message resumes (or, after an edit, forks) Claude Code's session
        claudeRef: result.stopped ? undefined : result.claudeRef
      };

      session.messages.push(assistantMessage);
      // A stopped reply leaves the session in the middle of a turn: the next message starts anew
      session.claudeHead = assistantMessage.claudeRef;
      session.updatedAt = new Date();
      // A chat deleted while its reply ran stays deleted; one the user left keeps the reply
      // without becoming the open chat again
      if (!this.sessionManager.saveReply(projectId, projectPath, session)) return;

      // Emit session-updated event for real-time UI updates
      this.emit('session-updated', projectId, session);
    } catch (error) {
      // Error already emitted by executor
      console.error('[InsightsService] Error executing insights:', error);
    } finally {
      // A message another session sent meanwhile is answered now (not after a stop or a failure)
      if (answeredFully) this.answerQueued(projectId, projectPath, session.id);
    }
  }

  /**
   * A stored attachment's base64 data (null if missing or outside the attachments dir)
   */
  private readAttachmentData(projectPath: string, relativePath: string): string | null {
    const absolutePath = this.paths.resolveAttachmentPath(projectPath, relativePath);
    if (!absolutePath || !existsSync(absolutePath)) return null;
    return readFileSync(absolutePath).toString('base64');
  }

  /**
   * Write an image attachment to disk; returns its path relative to the insights directory
   */
  private storeAttachment(projectPath: string, sessionId: string, attachment: ImageAttachment): string | undefined {
    if (!attachment.data) return undefined;
    const relativePath = this.paths.getAttachmentRelativePath(sessionId, attachment.id, attachment.mimeType);
    if (!relativePath) return undefined;
    try {
      const absolutePath = path.join(this.paths.getInsightsDir(projectPath), relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, Buffer.from(attachment.data, 'base64'));
      return relativePath;
    } catch (error) {
      console.error('[InsightsService] Failed to store attachment:', error);
      return undefined;
    }
  }

  /**
   * Read a stored image attachment as a data URL (null if missing or outside the attachments dir)
   */
  readAttachment(projectPath: string, relativePath: string, mimeType: string): string | null {
    const absolutePath = this.paths.resolveAttachmentPath(projectPath, relativePath);
    if (!absolutePath || !existsSync(absolutePath)) return null;
    return `data:${mimeType};base64,${readFileSync(absolutePath).toString('base64')}`;
  }

  /**
   * Update model configuration for a session
   */
  updateSessionModelConfig(projectPath: string, sessionId: string, modelConfig: InsightsModelConfig): boolean {
    return this.sessionManager.updateSessionModelConfig(projectPath, sessionId, modelConfig);
  }
}

// Singleton instance
export const insightsService = new InsightsService();
