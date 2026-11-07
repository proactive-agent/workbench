/**
 * Insights types
 */

import type { TaskMetadata, ImageAttachment } from './task';

// ============================================
// Insights Chat Types
// ============================================

import type { ThinkingLevel } from './settings';
import type { ModelType } from './task';
import type { PlaywrightBrowserChoice } from './browser-profiles';

// Model configuration for insights sessions
export interface InsightsModelConfig {
  profileId: string;           // 'complex' | 'balanced' | 'quick' | 'custom'
  model: ModelType;            // any model ID (e.g. 'sonnet', 'opus', or provider-specific model string)
  thinkingLevel: ThinkingLevel;
  /** The Kanban button: Claude gets the project's task tools in this conversation */
  kanbanTools?: boolean;
  /** The MCP button: connector ids for this conversation; unset = the Connectors defaults */
  mcpConnectors?: string[];
  /** The GitHub button: Claude can use the GitHub CLI (gh) in this conversation */
  githubTools?: boolean;
  /** The GitLab button: Claude can use the GitLab CLI (glab) in this conversation */
  gitlabTools?: boolean;
  /**
   * The Clawd button: the conversation's turns get what an agent window has (every tool, changing
   * the project's files, the user's own MCP servers, slash commands and skills). Turning it off
   * keeps the same Claude Code session; later turns are read-only again
   */
  agentMode?: boolean;
  /**
   * The browser the chat's Playwright opens (picked in the browser drawer; null: Playwright's own
   * Chromium); unset = the one in Settings > Connectors
   */
  playwrightBrowser?: PlaywrightBrowserChoice | null;
}

type InsightsChatRole = 'user' | 'assistant';

// Tool usage record for showing what tools the AI used
export interface InsightsToolUsage {
  name: string;
  input?: string;
  timestamp: Date;
}

export interface InsightsChatMessage {
  id: string;
  role: InsightsChatRole;
  content: string;
  timestamp: Date;
  // For assistant messages that suggest task creation
  suggestedTasks?: Array<{
    title: string;
    description: string;
    metadata?: TaskMetadata;
  }>;
  // Image attachments (screenshots, pasted images)
  images?: ImageAttachment[];
  // Tools used during this response (assistant messages only)
  toolsUsed?: InsightsToolUsage[];
  // The user stopped this reply (assistant messages only); content is what was written by then
  stopped?: boolean;
  /** Where this reply ends in Claude Code's session (assistant messages only) */
  claudeRef?: ClaudeSessionRef;
}

/**
 * A point in a Claude Code session: the session and its last assistant message at the end of a
 * reply, and the account whose config dir holds the session's transcript
 */
export interface ClaudeSessionRef {
  sessionId: string;
  messageUuid: string;
  /** Claude profile the session ran on (unset for API profiles) */
  profileId?: string;
}

export interface InsightsSession {
  id: string;
  projectId: string;
  title?: string; // Auto-generated from first message or user-set
  messages: InsightsChatMessage[];
  modelConfig?: InsightsModelConfig; // Per-session model configuration
  /**
   * The Claude Code session's latest point (the last reply that ended normally): a message that
   * follows a reply ending here resumes the session, one that follows an earlier reply (after an
   * edit or regenerate) forks it there
   */
  claudeHead?: ClaudeSessionRef;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

// Summary of a session for the history list (without full messages)
export interface InsightsSessionSummary {
  id: string;
  projectId: string;
  title: string;
  messageCount: number;
  modelConfig?: InsightsModelConfig; // For displaying model indicator in sidebar
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface InsightsChatStatus {
  phase: 'idle' | 'thinking' | 'streaming' | 'complete' | 'error';
  message?: string;
  error?: string;
}

export interface InsightsStreamChunk {
  type: 'text' | 'task_suggestion' | 'tool_start' | 'tool_end' | 'done' | 'error';
  content?: string;
  suggestedTasks?: Array<{
    title: string;
    description: string;
    metadata?: TaskMetadata;
  }>;
  tool?: {
    name: string;
    input?: string;  // Brief description of what's being searched/read
  };
  error?: string;
  /** The conversation the reply belongs to; the chat shows only its own conversation's reply */
  sessionId?: string;
}
