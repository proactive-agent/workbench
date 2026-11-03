import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  InsightsChatMessage,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsToolUsage,
  InsightsModelConfig,
  ImageAttachment,
  ClaudeSessionRef
} from '../../shared/types';
import { detectRateLimit, createSDKRateLimitInfo } from '../rate-limit-detector';
import { CHAT_BROWSER_URL_ENV, getTaskToolsRoute, runInsights, type InsightsSessionPlan } from './claude-code-runner';
import { getGraphifyPromptContext, isGraphifyEnabled } from '../graphify';
import { projectStore } from '../project-store';
import { openMcpToolsSession, openTaskToolsSession, type TaskToolsSession } from './task-tools-server';
import { buildMcpConfig, type McpServerEntry } from '../claude-code/mcp-config';
import { PLAYWRIGHT_MCP_PACKAGE } from '../browser-profiles/managed';
import { getWslInfo } from '../platform/shell-runtime';
import { browserDrawer } from '../browser-drawer';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { usableMcpConnectorIds } from '../mcp-availability';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import { readSettingsFileAsync } from '../settings-utils';
import { prepareBrowserProfileCopy, removeBrowserProfileCopy } from '../browser-profiles/profile-copy';
import { browserChoicesInUse } from '../browser-profiles/choices-in-use';
import { appLog } from '../app-logger';
import { getToolInfoAsync } from '../cli-tool-manager';
import { isSelfImproveEnabled } from '../self-improve/setting';
import { stripTaskSuggestions } from '../../shared/utils/task-suggestions';
import type { AppSettings } from '../../shared/types';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';

/**
 * Message processor result
 */
interface ProcessorResult {
  fullResponse: string;
  suggestedTasks?: InsightsChatMessage['suggestedTasks'];
  toolsUsed: InsightsToolUsage[];
  /** The user stopped the reply */
  stopped?: boolean;
  /** A newer message or regenerate stopped the reply; that run owns the conversation */
  replaced?: boolean;
  /** Where the reply ends in its Claude Code session (replies that ended normally) */
  claudeRef?: ClaudeSessionRef;
}

/** How a turn runs in Claude Code: the session to resume or fork, and the chat's title */
export interface InsightsTurnOptions {
  session?: InsightsSessionPlan;
  title?: string;
  /** The chat's conversation, sent with each stream chunk so only that chat shows the reply */
  chatSessionId?: string;
}

/** The chat whose turn runs: its browser is the chat's own (chat-browsers.ts) */
interface ChatBrowserTarget {
  projectId: string;
  chatId: string;
}

/**
 * A turn's Playwright server attached to the chat's own browser (`--endpoint`, its bind title),
 * through the guard, which asks for the browser to be opened (the turn's token) before each tool call
 */
async function attachedPlaywright(
  target: ChatBrowserTarget,
  choice: PlaywrightBrowserChoice | null | undefined,
): Promise<{ entry: McpServerEntry; session: TaskToolsSession }> {
  const session = await openMcpToolsSession({
    instructions: "Open the chat's browser.",
    tools: [{ name: 'open_chat_browser', description: "Open the chat's browser unless it is open", inputSchema: { type: 'object', properties: {} } }],
    call: async () => {
      await browserDrawer.openChatBrowser(target.projectId, target.chatId, choice);
      return 'open';
    },
  });
  const server = session.mcpServer;
  const title = browserDrawer.chatBrowsers.titleFor(target.projectId, target.chatId);
  return {
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', PLAYWRIGHT_MCP_PACKAGE, '--endpoint', title],
      env: {
        [CHAT_BROWSER_URL_ENV]: server.url,
        WORKBENCH_CHAT_BROWSER_TOKEN: server.headers.Authorization.replace(/^Bearer /, ''),
      },
    },
    session,
  };
}

/**
 * The chat's MCP servers: its own choice or the Connectors defaults, without unavailable ones.
 * Playwright attaches to the chat's own browser (opened on its first tool call, kept open between
 * turns); the caller closes the returned token when the turn ends. In WSL with interop off (the
 * guard can't reach Workbench), each turn gets a fresh copy of the browser profile (sign-ins as
 * they are now, like task runs), which the caller removes when the turn ends
 */
async function chatMcpServers(
  ids: string[] | undefined,
  projectPath: string,
  chatChoice: PlaywrightBrowserChoice | null | undefined,
  target: ChatBrowserTarget | undefined,
) {
  const connectorSettings = ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.mcpConnectors;
  const wanted = ids ?? getDefaultMcpConnectorIds(connectorSettings);
  // In WSL the guard reaches Workbench directly or through the Windows relay; with interop off it
  // can't, and each turn opens a browser of its own as before
  const chatBrowser = target && (!getWslInfo() || getTaskToolsRoute() !== 'off') ? target : undefined;
  // An open chat browser is usable whatever the chosen browser's check says now
  const open = chatBrowser && browserDrawer.chatBrowsers.isOpen(chatBrowser.projectId, chatBrowser.chatId);
  const usable = await usableMcpConnectorIds(open ? wanted.filter((id) => id !== 'playwright') : wanted, connectorSettings, undefined, chatChoice);
  const chosen = open && wanted.includes('playwright') ? [...usable, 'playwright'] : usable;
  if (chatBrowser && chosen.includes('playwright')) {
    const { entry, session } = await attachedPlaywright(chatBrowser, chatChoice);
    const mcpServers = { ...buildMcpConfig(chosen.filter((id) => id !== 'playwright'), connectorSettings).mcpServers, playwright: entry };
    return { mcpServers, browserProfileDir: undefined, chatBrowserSession: session };
  }
  const browser = chatChoice !== undefined ? chatChoice ?? undefined : connectorSettings?.playwrightBrowser;
  let browserProfileDir: string | undefined;
  if (browser && chosen.includes('playwright')) {
    // A slot per turn: a replaced turn may still be removing its own copy
    const slot = `chat-${randomUUID().slice(0, 8)}`;
    // Copies of profiles tasks still choose are kept by its sweep
    const inUse = await browserChoicesInUse(projectPath, browser).catch(() => undefined);
    browserProfileDir = (await prepareBrowserProfileCopy(projectPath, browser, slot, inUse).catch((error) => {
      appLog.warn('[Insights] Could not copy the browser profile:', error);
      return null;
    })) ?? undefined;
  }
  const runSettings = chatChoice !== undefined ? { ...connectorSettings, playwrightBrowser: browser } : connectorSettings;
  return {
    mcpServers: buildMcpConfig(chosen, runSettings as AppSettings['mcpConnectors'], { browserProfileDir }).mcpServers,
    browserProfileDir,
    chatBrowserSession: undefined as TaskToolsSession | undefined,
  };
}

/**
 * Settings > Agents: Task messaging (the chat's message_task delivers), and whether the user's
 * sessions may message running tasks (Task messaging and its sub-switch)
 */
async function messagingSwitches(): Promise<{ taskMessaging: boolean; sessionMessages: boolean }> {
  const stored = ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.claudeCodeTasks;
  const settings = resolveClaudeCodeTaskSettings(stored);
  return { taskMessaging: settings.taskMessaging, sessionMessages: settings.taskMessaging && settings.sessionMessages };
}

/** A running reply's key: one reply runs per chat, and a project's chats reply at the same time */
const runKey = (projectId: string, chatSessionId: string | undefined) => `${projectId}\n${chatSessionId ?? ''}`;

/**
 * Executor for insights: runs each chat turn through Claude Code. Every event names the chat
 * (`sessionId`), since several chats of a project may be replying at once
 */
export class InsightsExecutor extends EventEmitter {
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    super();
  }

  /**
   * Check if a chat is replying
   */
  isSessionActive(projectId: string, chatSessionId?: string): boolean {
    return this.abortControllers.has(runKey(projectId, chatSessionId));
  }

  /**
   * Stop a chat's reply; returns false when it had none
   */
  cancelSession(projectId: string, chatSessionId?: string): boolean {
    const key = runKey(projectId, chatSessionId);
    const controller = this.abortControllers.get(key);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(key);
    return true;
  }

  /**
   * Execute an insights query through Claude Code
   */
  async execute(
    projectId: string,
    projectPath: string,
    message: string,
    conversationHistory: Array<{ role: string; content: string }>,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    turn: InsightsTurnOptions = {}
  ): Promise<ProcessorResult> {
    // The chat's earlier reply (if any) stops; other chats' replies go on
    const key = runKey(projectId, turn.chatSessionId);
    this.cancelSession(projectId, turn.chatSessionId);
    const emitStatus = (status: InsightsChatStatus) => this.emit('status', projectId, status, turn.chatSessionId);

    emitStatus({
      phase: 'thinking',
      message: 'Processing your message...'
    });

    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    const emitChunk = (chunk: InsightsStreamChunk) =>
      this.emit('stream-chunk', projectId, { ...chunk, sessionId: turn.chatSessionId });

    const fullResponse = '';
    const suggestedTasks: InsightsChatMessage['suggestedTasks'] = [];
    const toolsUsed: InsightsToolUsage[] = [];
    let accumulatedText = '';
    let allOutput = '';

    const model = modelConfig?.model || 'sonnet';
    const thinkingLevel = modelConfig?.thinkingLevel ?? 'medium';

    // Map history to InsightsMessage format
    const history = conversationHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // With the Kanban button on, Claude can manage the project's tasks; the board reloads when a
    // tool changes them
    const taskTools = modelConfig?.kanbanTools
      ? await openTaskToolsSession({
        projectId,
        onTasksChanged: () => this.emit('tasks-changed', projectId),
      }).catch(() => undefined)
      : undefined;
    let browserProfileDir: string | undefined;
    let chatBrowserSession: TaskToolsSession | undefined;

    try {
      const projectSettings = projectStore.getProject(projectId)?.settings;
      // The project's memory graph, searchable from the chat when the project uses Graphify
      const graphify = (await isGraphifyEnabled(projectPath))
        ? (await getGraphifyPromptContext(projectPath)) ?? undefined
        : undefined;
      // The MCP servers chosen with the chat's MCP button (Connectors defaults until changed)
      // (leaving out servers that can't start)
      const mcp = await chatMcpServers(
        modelConfig?.mcpConnectors,
        projectPath,
        modelConfig?.playwrightBrowser,
        turn.chatSessionId ? { projectId, chatId: turn.chatSessionId } : undefined,
      );
      browserProfileDir = mcp.browserProfileDir;
      chatBrowserSession = mcp.chatBrowserSession;
      const result = await runInsights(
        {
          projectDir: projectPath,
          message,
          history,
          model,
          thinkingLevel,
          abortSignal: controller.signal,
          attachments: images,
          session: turn.session,
          title: turn.title,
          graphify,
          profileId: projectSettings?.claudeProfileId,
          taskTools: taskTools?.mcpServer,
          // gh and glab with the GitHub and GitLab buttons, when they are installed
          // Project memories can be saved when the project's self-improve switch is on
          memory: isSelfImproveEnabled(projectSettings),
          cliTools: {
            github: modelConfig?.githubTools === true && (await getToolInfoAsync('gh')).found,
            gitlab: modelConfig?.gitlabTools === true && (await getToolInfoAsync('glab')).found,
          },
          mcpServers: mcp.mcpServers,
          sharedBrowser: !!mcp.chatBrowserSession,
          // With the task tools: message_task (Task messaging on), and ListAgents and SendMessage
          // for other running sessions
          ...(await messagingSwitches()),
        },
        (event) => {
          switch (event.type) {
            case 'text-delta': {
              accumulatedText += event.text;
              allOutput = (allOutput + event.text).slice(-10000);
              emitChunk({
                type: 'text',
                content: event.text,
              });
              break;
            }
            case 'tool-start': {
              toolsUsed.push({
                name: event.name,
                input: event.input,
                timestamp: new Date(),
              });
              emitChunk({
                type: 'tool_start',
                tool: { name: event.name, input: event.input },
              });
              break;
            }
            case 'tool-end': {
              emitChunk({
                type: 'tool_end',
                tool: { name: event.name },
              });
              break;
            }
            case 'error': {
              allOutput = (allOutput + event.error).slice(-10000);
              emitChunk({
                type: 'error',
                error: event.error,
              });
              break;
            }
          }
        },
      );

      this.releaseController(key, controller);

      // Each suggestion line of the reply becomes a card
      if (result.taskSuggestions.length > 0) {
        const tasks = result.taskSuggestions.map(({ title, description }) => ({ title, description }));
        suggestedTasks.push(...tasks);
        emitChunk({
          type: 'task_suggestion',
          suggestedTasks: tasks,
        });
      }

      emitChunk({
        type: 'done',
      });

      emitStatus({
        phase: 'complete',
      });

      return {
        fullResponse: result.text.trim() || stripTaskSuggestions(accumulatedText).trim() || fullResponse,
        suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
        toolsUsed,
        claudeRef: result.claudeRef,
      };
    } catch (error) {
      this.releaseController(key, controller);

      // Check for rate limit in accumulated output
      this.handleRateLimit(projectId, allOutput);

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Don't emit error if aborted (user cancelled)
      if (error instanceof Error && error.name === 'AbortError') {
        // Stopped by the user: end the reply with what was written so far. When a newer message
        // replaced this run, that run owns the chat's state, so nothing is sent
        const replaced = this.abortControllers.has(key);
        if (!replaced) {
          emitChunk({ type: 'done' });
          emitStatus({ phase: 'complete' });
        }
        return {
          replaced,
          fullResponse: stripTaskSuggestions(accumulatedText).trim(),
          suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
          toolsUsed,
          stopped: !replaced,
        };
      }

      emitChunk({
        type: 'error',
        error: errorMsg,
      });

      this.emit('error', projectId, errorMsg, turn.chatSessionId);
      throw error;
    } finally {
      taskTools?.close();
      chatBrowserSession?.close();
      // The turn's Claude Code session (and its browser) has ended. Not awaited: the reply must be
      // returned (and saved) right after 'done', before a next message can start a turn
      if (browserProfileDir) void removeBrowserProfileCopy(browserProfileDir);
    }
  }

  /**
   * Forget a run's controller, unless a newer run already took its place
   */
  private releaseController(key: string, controller: AbortController): void {
    if (this.abortControllers.get(key) === controller) {
      this.abortControllers.delete(key);
    }
  }

  /**
   * Handle rate limit detection
   */
  private handleRateLimit(projectId: string, output: string): void {
    const rateLimitDetection = detectRateLimit(output);
    if (rateLimitDetection.isRateLimited) {
      const rateLimitInfo = createSDKRateLimitInfo('other', rateLimitDetection, {
        projectId,
      });
      this.emit('sdk-rate-limit', rateLimitInfo);
    }
  }
}
