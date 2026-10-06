/**
 * Insights via Claude Code
 * ========================
 *
 * Claude subscription (OAuth) accounts are only accepted by Anthropic's own clients, so for
 * those accounts the Insights chat runs each turn through the locally installed Claude Code
 * CLI in headless mode (`claude -p`) instead of calling the Messages API directly.
 *
 * The CLI runs read-only: only the Read/Glob/Grep tools are available, anything else is
 * denied without prompting (`--permission-mode dontAsk`), MCP servers are not loaded and no
 * session is persisted. Credentials come from the account's own CLAUDE_CONFIG_DIR, so the CLI
 * handles token refresh itself.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClaudeCliInvocationAsync } from '../../cli-utils';
import { getToolInfo } from '../../cli-tool-manager';
import { getSpawnCommand, getSpawnOptions } from '../../env-utils';
import { getProfileEnv } from '../../rate-limit-detector';
import { buildDefaultQueueConfig, resolveAuthFromQueue } from '../auth/resolver';
import { resolveModelId } from '../config/phase-config';
import { INSIGHTS_ERROR_CODES, formatInsightsError } from '../../../shared/constants/insights';
import type { ImageAttachment } from '../../../shared/types';
import { buildAttachmentParts } from './insights-attachments';
import {
  buildConversationPrompt,
  buildSystemPrompt,
  extractTaskSuggestion,
  extractToolInput,
  runInsightsQuery,
  EMPTY_RESPONSE_ERROR,
  type InsightsConfig,
  type InsightsResult,
  type InsightsStreamCallback,
  type ToolCallInfo,
} from './insights';

/** Tools the Insights agent may use through Claude Code (read-only codebase exploration) */
export const CLAUDE_CODE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** How Insights reaches the model for the current account */
export type InsightsBackend =
  | { kind: 'ai-sdk' }
  | { kind: 'claude-code'; modelId: string; profileEnv: Record<string, string> };

/**
 * Pick the backend for an Insights turn: Claude Code when the account the priority queue
 * resolves is an Anthropic subscription sign-in, the AI SDK for everything else.
 */
export async function resolveInsightsBackend(modelShorthand: string): Promise<InsightsBackend> {
  const queueConfig = buildDefaultQueueConfig(resolveModelId(modelShorthand));
  if (!queueConfig) return { kind: 'ai-sdk' };

  const auth = await resolveAuthFromQueue(queueConfig.requestedModel, queueConfig.queue);
  if (!auth || auth.resolvedProvider !== 'anthropic' || auth.source !== 'profile-oauth') {
    return { kind: 'ai-sdk' };
  }

  const account = queueConfig.queue.find((a) => a.id === auth.accountId);
  return {
    kind: 'claude-code',
    modelId: auth.resolvedModelId,
    profileEnv: getProfileEnv(account?.claudeProfileId),
  };
}

/** Run an Insights turn on the backend that fits the active account */
export async function runInsights(config: InsightsConfig, onStream?: InsightsStreamCallback): Promise<InsightsResult> {
  const backend = await resolveInsightsBackend(config.modelShorthand ?? 'sonnet');
  return backend.kind === 'claude-code'
    ? runInsightsViaClaudeCode(config, backend, onStream)
    : runInsightsQuery(config, onStream);
}

// =============================================================================
// Claude Code runner
// =============================================================================

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string };

/** Message content for Claude Code's stream-json input (Anthropic content blocks) */
export function buildClaudeCodeContent(prompt: string, attachments?: ImageAttachment[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [{ type: 'text', text: prompt }];
  for (const part of buildAttachmentParts(attachments)) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType ?? 'image/png', data: String(part.image) } });
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: part.mediaType, data: String(part.data) }, title: part.filename });
    }
  }
  return blocks;
}

/** CLI arguments for a read-only, non-persistent headless turn */
export function buildClaudeCodeArgs(modelId: string, thinkingLevel: string, systemPromptFile: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', modelId,
    '--effort', thinkingLevel,
    '--tools', CLAUDE_CODE_READ_ONLY_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--append-system-prompt-file', systemPromptFile,
  ];
}

/** Quote arguments containing spaces when the command runs through a shell (Windows .cmd shims) */
function quoteForShell(args: string[], useShell: boolean): string[] {
  return useShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
}

/** Credentials that would make Claude Code bill an API key instead of the subscription */
const API_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export interface StreamState {
  text: string;
  toolCalls: ToolCallInfo[];
  /** tool_use id → tool name, for matching tool results */
  toolNames: Map<string, string>;
  /** Content block index → in-progress tool call */
  pendingTools: Map<number, { id: string; name: string; json: string }>;
  result?: { isError: boolean; subtype?: string; text?: string };
}

/** Apply one stream-json event from the CLI to the run state, emitting UI events */
export function handleClaudeCodeEvent(
  event: Record<string, unknown>,
  state: StreamState,
  onStream?: InsightsStreamCallback,
): void {
  switch (event.type) {
    case 'stream_event': {
      const inner = event.event as Record<string, unknown> | undefined;
      const index = inner?.index as number | undefined;
      if (inner?.type === 'content_block_start') {
        const block = inner.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === 'tool_use' && index !== undefined) {
          state.pendingTools.set(index, { id: block.id ?? '', name: block.name ?? 'tool', json: '' });
        } else if (block?.type === 'text' && state.text) {
          // Separate text written before and after tool use
          state.text += '\n\n';
          onStream?.({ type: 'text-delta', text: '\n\n' });
        }
      } else if (inner?.type === 'content_block_delta') {
        const delta = inner.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          state.text += delta.text;
          onStream?.({ type: 'text-delta', text: delta.text });
        } else if (delta?.type === 'input_json_delta' && index !== undefined) {
          const pending = state.pendingTools.get(index);
          if (pending) pending.json += delta.partial_json ?? '';
        }
      } else if (inner?.type === 'content_block_stop' && index !== undefined) {
        const pending = state.pendingTools.get(index);
        if (pending) {
          state.pendingTools.delete(index);
          let args: Record<string, unknown> = {};
          try {
            args = pending.json ? (JSON.parse(pending.json) as Record<string, unknown>) : {};
          } catch {
            // Keep empty args if the CLI sent malformed partial JSON
          }
          const input = extractToolInput(args);
          state.toolNames.set(pending.id, pending.name);
          state.toolCalls.push({ name: pending.name, input });
          onStream?.({ type: 'tool-start', name: pending.name, input });
        }
      }
      break;
    }
    case 'user': {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
          if (block.type === 'tool_result') {
            onStream?.({ type: 'tool-end', name: state.toolNames.get(block.tool_use_id ?? '') ?? 'tool' });
          }
        }
      }
      break;
    }
    case 'result': {
      state.result = {
        isError: event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success'),
        subtype: event.subtype as string | undefined,
        text: typeof event.result === 'string' ? event.result : undefined,
      };
      break;
    }
  }
}

/**
 * Run an Insights turn through the Claude Code CLI.
 * Resolves like runInsightsQuery; rejects with a readable message when the CLI fails.
 */
export async function runInsightsViaClaudeCode(
  config: InsightsConfig,
  backend: Extract<InsightsBackend, { kind: 'claude-code' }>,
  onStream?: InsightsStreamCallback,
): Promise<InsightsResult> {
  const { projectDir, message, history = [], thinkingLevel = 'medium', abortSignal, attachments } = config;

  try {
    const cliInfo = getToolInfo('claude');
    if (!cliInfo.found) {
      throw new Error(formatInsightsError(INSIGHTS_ERROR_CODES.claudeCodeMissing, cliInfo.message || 'Claude Code CLI not found'));
    }

    const { command, env: baseEnv } = await getClaudeCliInvocationAsync();
    const env: Record<string, string> = { ...baseEnv, ...backend.profileEnv };
    for (const name of API_KEY_ENV_VARS) delete env[name];

    // System prompt goes through a file: no argument length or shell quoting limits
    const tempDir = mkdtempSync(join(tmpdir(), 'auto-claude-insights-'));
    const systemPromptFile = join(tempDir, 'system-prompt.md');
    writeFileSync(systemPromptFile, buildSystemPrompt(projectDir), 'utf-8');

    const input = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: buildClaudeCodeContent(buildConversationPrompt(message, history), attachments) },
    });

    const state: StreamState = {
      text: '',
      toolCalls: [],
      toolNames: new Map(),
      pendingTools: new Map(),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const spawnOptions = getSpawnOptions(command, { cwd: projectDir, env, windowsHide: true, stdio: 'pipe' });
        const args = quoteForShell(buildClaudeCodeArgs(backend.modelId, thinkingLevel, systemPromptFile), spawnOptions.shell);
        const child = spawn(getSpawnCommand(command), args, spawnOptions);

        let stdoutBuffer = '';
        let stderr = '';
        const onAbort = () => child.kill();
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdoutBuffer += chunk;
          let newline = stdoutBuffer.indexOf('\n');
          while (newline !== -1) {
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line) {
              try {
                handleClaudeCodeEvent(JSON.parse(line) as Record<string, unknown>, state, onStream);
              } catch {
                // Ignore non-JSON lines (e.g. CLI warnings)
              }
            }
            newline = stdoutBuffer.indexOf('\n');
          }
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-4000);
        });

        child.on('error', (error) => {
          abortSignal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        child.on('close', (code) => {
          abortSignal?.removeEventListener('abort', onAbort);
          if (abortSignal?.aborted) {
            const abortError = new Error('Insights request was cancelled');
            abortError.name = 'AbortError';
            reject(abortError);
            return;
          }
          if (state.result?.isError) {
            reject(new Error(state.result.text?.trim() || `Claude Code failed (${state.result.subtype ?? 'error'})`));
            return;
          }
          if (code !== 0 && !state.result) {
            reject(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
            return;
          }
          resolve();
        });

        child.stdin?.end(`${input}\n`);
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const text = state.text.trim() ? state.text : (state.result?.text ?? '');
    if (!text.trim()) {
      throw new Error(EMPTY_RESPONSE_ERROR);
    }

    return { text, taskSuggestion: extractTaskSuggestion(text), toolCalls: state.toolCalls };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!(error instanceof Error && error.name === 'AbortError')) {
      onStream?.({ type: 'error', error: errorMsg });
    }
    throw error;
  }
}
