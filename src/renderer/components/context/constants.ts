import type { MemoryType } from '../../../shared/types';

// Memory type labels for display (16 types)
export const memoryTypeLabels: Record<MemoryType, string> = {
  gotcha: 'Gotcha',
  decision: 'Decision',
  preference: 'Preference',
  pattern: 'Pattern',
  requirement: 'Requirement',
  error_pattern: 'Error Pattern',
  module_insight: 'Module Insight',
  prefetch_pattern: 'Prefetch Pattern',
  work_state: 'Work State',
  causal_dependency: 'Causal Dependency',
  task_calibration: 'Task Calibration',
  e2e_observation: 'E2E Observation',
  dead_end: 'Dead End',
  work_unit_outcome: 'Work Unit Outcome',
  workflow_recipe: 'Workflow Recipe',
  context_cost: 'Context Cost'
};

// Filter categories for grouping memory types
export const memoryFilterCategories = [
  { key: 'all', label: 'All', types: [] as MemoryType[] },
  { key: 'patterns', label: 'Patterns', types: ['pattern', 'workflow_recipe', 'prefetch_pattern'] as MemoryType[] },
  { key: 'errors', label: 'Errors & Gotchas', types: ['error_pattern', 'dead_end', 'gotcha'] as MemoryType[] },
  { key: 'decisions', label: 'Decisions', types: ['decision', 'preference', 'requirement'] as MemoryType[] },
  { key: 'insights', label: 'Code Insights', types: ['module_insight', 'causal_dependency', 'e2e_observation'] as MemoryType[] },
  { key: 'calibration', label: 'Calibration', types: ['task_calibration', 'work_unit_outcome', 'work_state', 'context_cost'] as MemoryType[] },
] as const;

export type MemoryFilterCategory = typeof memoryFilterCategories[number]['key'];

