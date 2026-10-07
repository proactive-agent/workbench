import {
  Server,
  Globe,
  Cog,
  Code,
  Package,
  GitBranch,
  FileCode,
  Lightbulb,
  FolderTree,
  AlertTriangle,
  Smartphone,
  Monitor,
  GitPullRequest,
  Bug,
  Sparkles,
  Target,
  GitMerge,
  Wrench,
  BarChart2,
  Layers,
  Link,
  CheckCircle2,
  BookOpen,
  DollarSign,
  Star,
  ClipboardList,
  RefreshCw
} from 'lucide-react';
import type { MemoryType } from '../../../shared/types';

// Service type icon mapping
export const serviceTypeIcons: Record<string, React.ElementType> = {
  backend: Server,
  frontend: Globe,
  worker: Cog,
  scraper: Code,
  library: Package,
  proxy: GitBranch,
  mobile: Smartphone,
  desktop: Monitor,
  unknown: FileCode
};

// Service type badge classes (neutral, claude.ai style)
export const serviceTypeColors: Record<string, string> = {
  backend: 'bg-segment-track text-muted-foreground border-transparent',
  frontend: 'bg-segment-track text-muted-foreground border-transparent',
  worker: 'bg-segment-track text-muted-foreground border-transparent',
  scraper: 'bg-segment-track text-muted-foreground border-transparent',
  library: 'bg-segment-track text-muted-foreground border-transparent',
  proxy: 'bg-segment-track text-muted-foreground border-transparent',
  mobile: 'bg-segment-track text-muted-foreground border-transparent',
  desktop: 'bg-segment-track text-muted-foreground border-transparent',
  unknown: 'bg-segment-track text-muted-foreground border-transparent'
};

// Memory type icon mapping (16 types)
export const memoryTypeIcons: Record<MemoryType, React.ElementType> = {
  gotcha: AlertTriangle,
  decision: GitMerge,
  preference: Star,
  pattern: RefreshCw,
  requirement: ClipboardList,
  error_pattern: Bug,
  module_insight: Lightbulb,
  prefetch_pattern: Package,
  work_state: Wrench,
  causal_dependency: Link,
  task_calibration: BarChart2,
  e2e_observation: Monitor,
  dead_end: Target,
  work_unit_outcome: CheckCircle2,
  workflow_recipe: BookOpen,
  context_cost: DollarSign
};

// Memory type badge classes (neutral, claude.ai style; 16 types)
export const memoryTypeColors: Record<MemoryType, string> = {
  gotcha: 'bg-segment-track text-muted-foreground border-transparent',
  decision: 'bg-segment-track text-muted-foreground border-transparent',
  preference: 'bg-segment-track text-muted-foreground border-transparent',
  pattern: 'bg-segment-track text-muted-foreground border-transparent',
  requirement: 'bg-segment-track text-muted-foreground border-transparent',
  error_pattern: 'bg-segment-track text-muted-foreground border-transparent',
  module_insight: 'bg-segment-track text-muted-foreground border-transparent',
  prefetch_pattern: 'bg-segment-track text-muted-foreground border-transparent',
  work_state: 'bg-segment-track text-muted-foreground border-transparent',
  causal_dependency: 'bg-segment-track text-muted-foreground border-transparent',
  task_calibration: 'bg-segment-track text-muted-foreground border-transparent',
  e2e_observation: 'bg-segment-track text-muted-foreground border-transparent',
  dead_end: 'bg-segment-track text-muted-foreground border-transparent',
  work_unit_outcome: 'bg-segment-track text-muted-foreground border-transparent',
  workflow_recipe: 'bg-segment-track text-muted-foreground border-transparent',
  context_cost: 'bg-segment-track text-muted-foreground border-transparent'
};

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

// Legacy icons kept for backward compatibility with any code still referencing old types
export const legacyMemoryTypeIcons: Record<string, React.ElementType> = {
  session_insight: Lightbulb,
  codebase_discovery: FolderTree,
  codebase_map: FolderTree,
  task_outcome: Target,
  qa_result: Target,
  historical_context: Lightbulb,
  pr_review: GitPullRequest,
  pr_finding: Bug,
  pr_pattern: Sparkles,
  pr_gotcha: AlertTriangle
};

// Legacy colors kept for backward compatibility
export const legacyMemoryTypeColors: Record<string, string> = {
  session_insight: 'bg-segment-track text-muted-foreground border-transparent',
  codebase_discovery: 'bg-segment-track text-muted-foreground border-transparent',
  codebase_map: 'bg-segment-track text-muted-foreground border-transparent',
  task_outcome: 'bg-segment-track text-muted-foreground border-transparent',
  qa_result: 'bg-segment-track text-muted-foreground border-transparent',
  historical_context: 'bg-segment-track text-muted-foreground border-transparent',
  pr_review: 'bg-segment-track text-muted-foreground border-transparent',
  pr_finding: 'bg-segment-track text-muted-foreground border-transparent',
  pr_pattern: 'bg-segment-track text-muted-foreground border-transparent',
  pr_gotcha: 'bg-segment-track text-muted-foreground border-transparent'
};
