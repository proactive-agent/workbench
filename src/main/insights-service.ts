import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatMessage,
  InsightsModelConfig,
  ImageAttachment
} from '../shared/types';
import { MAX_IMAGES_PER_TASK } from '../shared/constants';
import { InsightsConfig } from './insights/config';
import { InsightsPaths } from './insights/paths';
import { SessionStorage } from './insights/session-storage';
import { SessionManager } from './insights/session-manager';
import { InsightsExecutor } from './insights/insights-executor';
import type { InsightsSessionPlan } from './insights/claude-code-runner';
import { browserDrawer } from './browser-drawer';

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
    images?: ImageAttachment[]
  ): Promise<void> {
    // Load or create session
    let session = this.sessionManager.loadSession(projectId, projectPath);
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
      images: persistImages && persistImages.length > 0 ? persistImages : undefined
    };
    session.messages.push(userMessage);
    if (modelConfig) session.modelConfig = modelConfig;
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);
    // The chat (and the history list) learn the conversation now, a new one included
    this.emit('session-updated', projectId, session);

    await this.reply(projectId, projectPath, session, message, modelConfig, images);
  }

  /**
   * Write the latest reply again: the conversation's last reply is replaced by a new answer to
   * the message before it, with that message's attachments
   */
  async regenerate(projectId: string, projectPath: string, modelConfig?: InsightsModelConfig, sessionId?: string): Promise<void> {
    const session = this.loadShownSession(projectId, projectPath, sessionId);
    if (session) this.executor.cancelSession(projectId, session.id);
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

    await this.reply(projectId, projectPath, session, userMessage.content, modelConfig, this.loadAttachments(projectPath, userMessage));
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
    const userMessage: InsightsChatMessage = {
      ...original,
      id: newMessageId(),
      content,
      timestamp: new Date()
    };
    session.messages = [...session.messages.slice(0, index), userMessage];
    if (modelConfig) session.modelConfig = modelConfig;
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);
    this.emit('session-updated', projectId, session);

    await this.reply(projectId, projectPath, session, content, modelConfig, this.loadAttachments(projectPath, userMessage));
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
      return { role: m.role, content: m.content + imageNotation };
    });

    // Use provided modelConfig or fall back to session's config
    const configToUse = modelConfig || session.modelConfig;

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
