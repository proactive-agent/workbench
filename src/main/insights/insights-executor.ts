import { EventEmitter } from 'events';
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
import { runInsights, type InsightsSessionPlan } from './claude-code-runner';
import { getGraphifyPromptContext, isGraphifyEnabled } from '../graphify';
import { projectStore } from '../project-store';
import { openTaskToolsSession } from './task-tools-server';
import { buildMcpConfig } from '../claude-code/mcp-config';
import { usableMcpConnectorIds } from '../mcp-availability';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import { readSettingsFileAsync } from '../settings-utils';
import { prepareBrowserProfileCopy } from '../browser-profiles/profile-copy';
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

/**
 * Chats' copies of the Puppeteer browser profile, per project and profile: made by the first turn
 * that uses it in this app session and kept for later turns (a project's turns run one at a time)
 */
const chatBrowserProfiles = new Map<string, Promise<string | null>>();

/** The chat's MCP servers: its own choice or the Connectors defaults, without unavailable ones */
async function chatMcpServers(ids: string[] | undefined, projectPath: string) {
  const connectorSettings = ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.mcpConnectors;
  const chosen = usableMcpConnectorIds(ids ?? getDefaultMcpConnectorIds(connectorSettings), connectorSettings);
  const browser = connectorSettings?.puppeteerBrowser;
  let browserProfileDir: string | undefined;
  if (browser && chosen.includes('puppeteer')) {
    const key = `${projectPath}|${browser.id}`;
    let copy = chatBrowserProfiles.get(key);
    if (!copy) {
      copy = prepareBrowserProfileCopy(projectPath, browser, 'chat').catch(() => null);
      chatBrowserProfiles.set(key, copy);
    }
    browserProfileDir = (await copy) ?? undefined;
    // A failed copy (the browser held its files) is tried again by the next turn
    if (!browserProfileDir) chatBrowserProfiles.delete(key);
  }
  return buildMcpConfig(chosen, connectorSettings, { browserProfileDir }).mcpServers;
}

/** Settings > Agents lets the user's sessions message running tasks (Task messaging and its sub-switch) */
async function sessionMessagesEnabled(): Promise<boolean> {
  const stored = ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.claudeCodeTasks;
  const settings = resolveClaudeCodeTaskSettings(stored);
  return settings.taskMessaging && settings.sessionMessages;
}

/**
 * Executor for insights: runs each chat turn through Claude Code
 */
export class InsightsExecutor extends EventEmitter {
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    super();
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(projectId: string): boolean {
    return this.abortControllers.has(projectId);
  }

  /**
   * Cancel an active session
   */
  cancelSession(projectId: string): boolean {
    const controller = this.abortControllers.get(projectId);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(projectId);
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
    // Cancel any existing session
    this.cancelSession(projectId);

    // Emit thinking status
    this.emit('status', projectId, {
      phase: 'thinking',
      message: 'Processing your message...'
    } as InsightsChatStatus);

    const controller = new AbortController();
    this.abortControllers.set(projectId, controller);
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

    try {
      const projectSettings = projectStore.getProject(projectId)?.settings;
      // The project's memory graph, searchable from the chat when the project uses Graphify
      const graphify = (await isGraphifyEnabled(projectPath))
        ? (await getGraphifyPromptContext(projectPath)) ?? undefined
        : undefined;
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
          // The MCP servers chosen with the chat's MCP button (Connectors defaults until changed)
          // (leaving out servers that can't start)
          mcpServers: await chatMcpServers(modelConfig?.mcpConnectors, projectPath),
          // With the task tools: ListAgents and SendMessage for other running sessions
          sessionMessages: await sessionMessagesEnabled(),
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

      this.releaseController(projectId, controller);

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

      this.emit('status', projectId, {
        phase: 'complete',
      } as InsightsChatStatus);

      return {
        fullResponse: result.text.trim() || stripTaskSuggestions(accumulatedText).trim() || fullResponse,
        suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
        toolsUsed,
        claudeRef: result.claudeRef,
      };
    } catch (error) {
      this.releaseController(projectId, controller);

      // Check for rate limit in accumulated output
      this.handleRateLimit(projectId, allOutput);

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Don't emit error if aborted (user cancelled)
      if (error instanceof Error && error.name === 'AbortError') {
        // Stopped by the user: end the reply with what was written so far. When a newer message
        // replaced this run, that run owns the chat's state, so nothing is sent
        const replaced = this.abortControllers.has(projectId);
        if (!replaced) {
          emitChunk({ type: 'done' });
          this.emit('status', projectId, { phase: 'complete' } as InsightsChatStatus);
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

      this.emit('error', projectId, errorMsg);
      throw error;
    } finally {
      taskTools?.close();
    }
  }

  /**
   * Forget a run's controller, unless a newer run already took its place
   */
  private releaseController(projectId: string, controller: AbortController): void {
    if (this.abortControllers.get(projectId) === controller) {
      this.abortControllers.delete(projectId);
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
