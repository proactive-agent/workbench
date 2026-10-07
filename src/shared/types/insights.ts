/**
 * Insights types
 */

import type { TaskMetadata, ImageAttachment } from './task';

// ============================================
// Insights Chat Types
// ============================================

import type { ThinkingLevel } from './settings';
import type { ModelType } from './task';

// Model configuration for insights sessions
export interface InsightsModelConfig {
  profileId: string;           // 'complex' | 'balanced' | 'quick' | 'custom'
  model: ModelType;            // any model ID (e.g. 'sonnet', 'opus', or provider-specific model string)
  thinkingLevel: ThinkingLevel;
}

export type InsightsChatRole = 'user' | 'assistant';

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
}

export interface InsightsSession {
  id: string;
  projectId: string;
  title?: string; // Auto-generated from first message or user-set
  messages: InsightsChatMessage[];
  modelConfig?: InsightsModelConfig; // Per-session model configuration
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
}
