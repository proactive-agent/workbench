import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import path from "path";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import {
  IPC_CHANNELS,
  getSpecsDir,
  AUTO_BUILD_PATHS,
} from "../../shared/constants";
import type {
  IPCResult,
  InsightsSession,
  InsightsSessionSummary,
  InsightsModelConfig,
  ChatSlashCommand,
  ChatCommandsError,
  OpenWindowAsChatError,
  SessionMessageOrigin,
  ImageAttachment,
  Task,
  TaskMetadata,
} from "../../shared/types";
import { projectStore } from "../project-store";
import { insightsService } from "../insights-service";
import { safeSendToRenderer } from "./utils";
import { ChatCommandsListError, listChatCommands } from "../insights/chat-commands";
import { appLog } from "../app-logger";
import { findWindow } from "../session-messaging/directory";
import { windowChatSource } from "../session-messaging/window-session";
import { sessionWindow } from "../session-messaging/shared-session";
import type { SharedSessionWindow } from "../../shared/types/insights";
import { parseSessionName } from "../../shared/utils/session-names";
import type { ThinkingLevel } from "../../shared/types/settings";

/** Default model for Insights turns (Claude Code model alias) */
function getInsightsFeatureSettings(): InsightsModelConfig {
  return { profileId: "balanced", model: "sonnet", thinkingLevel: "medium" as ThinkingLevel };
}

/** The recipient a sent message names (a pasted session name), when it is a well-formed one */
function sessionOrigin(value: unknown): SessionMessageOrigin | undefined {
  const origin = value as Partial<SessionMessageOrigin> | undefined;
  if (!origin || (origin.kind !== "chat" && origin.kind !== "agent") || typeof origin.name !== "string") return undefined;
  const parsed = parseSessionName(origin.name);
  if (!parsed || parsed.kind !== origin.kind) return undefined;
  return { kind: parsed.kind, name: parsed.name, ...(typeof origin.title === "string" ? { title: origin.title.slice(0, 200) } : {}) };
}

/**
 * Register all insights-related IPC handlers
 */
export function registerInsightsHandlers(getMainWindow: () => BrowserWindow | null): void {
  // ============================================
  // Insights Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_GET_SESSION,
    async (_, projectId: string): Promise<IPCResult<InsightsSession | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const session = insightsService.loadSession(projectId, project.path);
      return { success: true, data: session };
    }
  );

  // Send an edited message in place of the original and everything after it
  ipcMain.on(
    IPC_CHANNELS.INSIGHTS_EDIT_MESSAGE,
    async (_, projectId: string, messageId: string, content: string, modelConfig?: InsightsModelConfig, sessionId?: string) => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, "Project not found");
        return;
      }
      try {
        await insightsService.editMessage(projectId, project.path, messageId, content, { ...getInsightsFeatureSettings(), ...modelConfig }, sessionId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, `Failed to send message: ${errorMessage}`);
      }
    }
  );

  // Stop the reply Claude is writing and write it again
  ipcMain.on(
    IPC_CHANNELS.INSIGHTS_REGENERATE,
    async (_, projectId: string, modelConfig?: InsightsModelConfig, sessionId?: string) => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, "Project not found");
        return;
      }
      try {
        await insightsService.regenerate(projectId, project.path, { ...getInsightsFeatureSettings(), ...modelConfig }, sessionId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, `Failed to send message: ${errorMessage}`);
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.INSIGHTS_SEND_MESSAGE,
    async (_, projectId: string, message: string, modelConfig?: InsightsModelConfig, images?: ImageAttachment[], to?: unknown) => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        safeSendToRenderer(
          getMainWindow,
          IPC_CHANNELS.INSIGHTS_ERROR,
          projectId,
          "Project not found"
        );
        return;
      }

      // Get feature settings from Agent Settings and merge with provided config
      const featureSettings = getInsightsFeatureSettings();
      const configWithSettings: InsightsModelConfig = {
        // Start with feature settings as defaults
        ...featureSettings,
        // Override with any explicitly provided config
        ...modelConfig,
      };

      console.log("[Insights Handler] Using model config:", {
        model: configWithSettings.model,
        thinkingLevel: configWithSettings.thinkingLevel,
      });

      // Await the async sendMessage to ensure proper error handling and
      // that all async operations (like getProcessEnv) complete before
      // the handler returns. This fixes race conditions on Windows where
      // environment setup wouldn't complete before process spawn.
      try {
        await insightsService.sendMessage(projectId, project.path, message, configWithSettings, images, sessionOrigin(to));
      } catch (error) {
        // Errors during sendMessage (executor errors) are already emitted via
        // the 'error' event, but we catch here to prevent unhandled rejection
        // and ensure all error types are reported to the UI
        console.error("[Insights IPC] Error in sendMessage:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeSendToRenderer(
          getMainWindow,
          IPC_CHANNELS.INSIGHTS_ERROR,
          projectId,
          `Failed to send message: ${errorMessage}`
        );
      }
    }
  );

  // Stop the reply Claude is writing in a chat; what it wrote so far is kept
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_STOP,
    (_, projectId: string, sessionId?: string): boolean =>
      insightsService.stopMessage(projectId, typeof sessionId === "string" ? sessionId : undefined)
  );

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_CLEAR_SESSION,
    async (_, projectId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      insightsService.clearSession(projectId, project.path);
      return { success: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_CREATE_TASK,
    async (
      _,
      projectId: string,
      title: string,
      description: string,
      metadata?: TaskMetadata
    ): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: "Workbench not initialized for this project" };
      }

      try {
        // Generate a unique spec ID based on existing specs
        // Get specs directory path
        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const specsDir = path.join(project.path, specsBaseDir);

        // Find next available spec number
        let specNumber = 1;
        if (existsSync(specsDir)) {
          const existingDirs = readdirSync(specsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

          const existingNumbers = existingDirs
            .map((name) => {
              const match = name.match(/^(\d+)/);
              return match ? parseInt(match[1], 10) : 0;
            })
            .filter((n) => n > 0);

          if (existingNumbers.length > 0) {
            specNumber = Math.max(...existingNumbers) + 1;
          }
        }

        // Create spec ID with zero-padded number and slugified title
        const slugifiedTitle = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 50);
        const specId = `${String(specNumber).padStart(3, "0")}-${slugifiedTitle}`;

        // Create spec directory
        const specDir = path.join(specsDir, specId);
        mkdirSync(specDir, { recursive: true });

        // Build metadata with source type
        const taskMetadata: TaskMetadata = {
          sourceType: "insights",
          ...metadata,
          userDescription: description,
        };

        // Create initial implementation_plan.json
        const now = new Date().toISOString();
        const implementationPlan = {
          feature: title,
          description: description,
          created_at: now,
          updated_at: now,
          status: "pending",
          phases: [],
        };

        const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        writeFileSync(planPath, JSON.stringify(implementationPlan, null, 2), 'utf-8');

        // Save task metadata
        const metadataPath = path.join(specDir, "task_metadata.json");
        writeFileSync(metadataPath, JSON.stringify(taskMetadata, null, 2), 'utf-8');

        // Create the task object
        const task: Task = {
          id: specId,
          specId: specId,
          projectId,
          title,
          description,
          status: "backlog",
          subtasks: [],
          logs: [],
          metadata: taskMetadata,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return { success: true, data: task };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to create task",
        };
      }
    }
  );

  // List all sessions for a project
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_LIST_SESSIONS,
    async (_, projectId: string, includeArchived?: boolean): Promise<IPCResult<InsightsSessionSummary[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const sessions = insightsService.listSessions(project.path, includeArchived ?? false);
      return { success: true, data: sessions };
    }
  );

  // Delete multiple sessions
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_DELETE_SESSIONS,
    async (_, projectId: string, sessionIds: string[]): Promise<IPCResult<{ deletedIds: string[]; failedIds: string[] }>> => {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return { success: false, error: "No sessions specified" };
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const result = insightsService.deleteSessions(projectId, project.path, sessionIds);
      return {
        success: result.failedIds.length === 0,
        data: result,
        ...(result.failedIds.length > 0 && { error: `Failed to delete ${result.failedIds.length} session(s)` })
      };
    }
  );

  // Archive a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.archiveSession(projectId, project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to archive session" };
    }
  );

  // Archive multiple sessions
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSIONS,
    async (_, projectId: string, sessionIds: string[]): Promise<IPCResult<{ archivedIds: string[]; failedIds: string[] }>> => {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return { success: false, error: "No sessions specified" };
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const result = insightsService.archiveSessions(projectId, project.path, sessionIds);
      return {
        success: result.failedIds.length === 0,
        data: result,
        ...(result.failedIds.length > 0 && { error: `Failed to archive ${result.failedIds.length} session(s)` })
      };
    }
  );

  // Unarchive a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_UNARCHIVE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.unarchiveSession(project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to unarchive session" };
    }
  );

  // Create a new session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_NEW_SESSION,
    async (_, projectId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      insightsService.startNewChat(projectId, project.path);
      return { success: true };
    }
  );

  // Switch to a different session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_SWITCH_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult<InsightsSession | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const session = insightsService.switchSession(projectId, project.path, sessionId);
      return { success: true, data: session };
    }
  );

  // Delete a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_DELETE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.deleteSession(projectId, project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to delete session" };
    }
  );

  // Rename a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_RENAME_SESSION,
    async (_, projectId: string, sessionId: string, newTitle: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.renameSession(project.path, sessionId, newTitle);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to rename session" };
    }
  );

  // Full-size image attachment of a message (stored under the insights attachments dir)
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_GET_ATTACHMENT,
    async (_, projectId: string, relativePath: string, mimeType: string): Promise<IPCResult<string>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
        return { success: false, error: "Unsupported attachment type" };
      }
      const dataUrl = insightsService.readAttachment(project.path, relativePath, mimeType);
      return dataUrl ? { success: true, data: dataUrl } : { success: false, error: "Attachment not found" };
    }
  );

  // Claude Code's slash commands and skills in the project (the chat's `/` menu)
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_LIST_COMMANDS,
    async (_, projectId: string): Promise<IPCResult<ChatSlashCommand[]>> => {
      // The error is a ChatCommandsError code, which the renderer words
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "projectNotFound" satisfies ChatCommandsError };
      }
      try {
        return { success: true, data: await listChatCommands(project.path, project.settings?.claudeProfileId) };
      } catch (error) {
        if (!(error instanceof ChatCommandsListError)) appLog.warn("[Insights] Listing Claude Code's commands failed:", error);
        return { success: false, error: error instanceof ChatCommandsListError ? error.code : ("failed" satisfies ChatCommandsError) };
      }
    }
  );

  // An agent window's Claude Code session as a chat (the error is an OpenWindowAsChatError code)
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_OPEN_WINDOW_AS_CHAT,
    async (_, projectId: string, terminalId: string): Promise<IPCResult<string>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: "projectNotFound" satisfies OpenWindowAsChatError };
      const terminal = findWindow(terminalId);
      if (!terminal) return { success: false, error: "windowNotFound" satisfies OpenWindowAsChatError };
      try {
        const source = await windowChatSource(terminal);
        const chatId = source ? await insightsService.openSessionAsChat(projectId, project.path, source) : null;
        return chatId ? { success: true, data: chatId } : { success: false, error: "noSession" satisfies OpenWindowAsChatError };
      } catch (error) {
        appLog.warn("[Insights] Could not open an agent window as a chat:", error);
        return { success: false, error: "failed" satisfies OpenWindowAsChatError };
      }
    }
  );

  // The agent window running a Claude Code session of the project (a chat's, opened with its Clawd
  // button), or null: the chat shows that window instead of opening another, and waits while it works
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_SESSION_WINDOW,
    async (_, projectId: string, claudeSessionId: string): Promise<IPCResult<SharedSessionWindow | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project || typeof claudeSessionId !== "string") return { success: false, error: "Project not found" };
      const found = await sessionWindow(project.path, claudeSessionId).catch(() => undefined);
      return {
        success: true,
        data: found ? { terminalId: found.terminal.id, busy: found.busy, resumable: found.atShell && found.shellIdle } : null,
      };
    }
  );

  // What an agent window said in a chat's session since the chat's last reply comes into the chat
  // (the window's turn ended); whether the chat changed
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_SYNC_SHARED_SESSION,
    async (_, projectId: string, chatId: string): Promise<IPCResult<boolean>> => {
      const project = projectStore.getProject(projectId);
      if (!project || typeof chatId !== "string") return { success: false, error: "Project not found" };
      return { success: true, data: await insightsService.syncSharedSession(projectId, project.path, chatId) };
    }
  );

  // Update model configuration for a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_UPDATE_MODEL_CONFIG,
    async (
      _,
      projectId: string,
      sessionId: string,
      modelConfig: InsightsModelConfig
    ): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.updateSessionModelConfig(
        project.path,
        sessionId,
        modelConfig
      );
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to update model configuration" };
    }
  );

  // ============================================
  // Insights Event Forwarding (Service -> Renderer)
  // ============================================

  // Forward streaming chunks to renderer
  // The chat's task tools changed tasks: the board reloads them
  insightsService.on("tasks-changed", (projectId: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LIST_CHANGED, projectId);
  });

  insightsService.on("stream-chunk", (projectId: string, chunk: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_STREAM_CHUNK, projectId, chunk);
  });

  // Forward status updates to renderer
  // Status and errors name the chat (several chats of a project may be replying)
  insightsService.on("status", (projectId: string, status: unknown, sessionId?: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_STATUS, projectId, status, sessionId);
  });

  // Forward errors to renderer
  insightsService.on("error", (projectId: string, error: string, sessionId?: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, error, sessionId);
  });

  // Forward SDK rate limit events to renderer
  insightsService.on("sdk-rate-limit", (rateLimitInfo: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Forward session-updated events to renderer for real-time UI updates
  insightsService.on("session-updated", (projectId: string, session: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_SESSION_UPDATED, projectId, session);
  });
}
