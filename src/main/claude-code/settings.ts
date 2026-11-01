import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_CODE_TASK_SETTINGS,
  WORKFLOW_SIZES,
  type ClaudeCodeTaskSettings,
} from '../../shared/types/claude-code';

/** Complete task settings from the stored (partial) `AppSettings.claudeCodeTasks` */
export function resolveClaudeCodeTaskSettings(stored: Partial<ClaudeCodeTaskSettings> | undefined): ClaudeCodeTaskSettings {
  const merged = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, ...(stored ?? {}) };
  if (!CLAUDE_MODEL_ALIASES.includes(merged.fixedModel)) merged.fixedModel = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.fixedModel;
  if (!CLAUDE_MODEL_ALIASES.includes(merged.triageModel)) merged.triageModel = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.triageModel;
  if (!CLAUDE_EFFORTS.includes(merged.fixedEffort)) merged.fixedEffort = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.fixedEffort;
  if (merged.triage !== 'auto' && merged.triage !== 'fixed') merged.triage = 'auto';
  if (!['auto', 'always', 'never'].includes(merged.planning)) merged.planning = 'auto';
  if (typeof merged.taskMessaging !== 'boolean') merged.taskMessaging = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.taskMessaging;
  if (!WORKFLOW_SIZES.includes(merged.workflowSize)) merged.workflowSize = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.workflowSize;
  // Claude Code accepts 1 to 256; anything else means its own default
  const concurrency = merged.workflowMaxConcurrentAgents;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 256)) {
    delete merged.workflowMaxConcurrentAgents;
  }
  return merged;
}
