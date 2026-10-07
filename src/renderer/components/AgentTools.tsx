/**
 * Agent Tools Overview
 *
 * Displays MCP server and tool configuration for each agent phase.
 * Helps users understand what tools are available during different execution phases.
 * Now shows per-project MCP configuration with toggles to enable/disable servers.
 */

import {
  Server,
  Brain,
  Search,
  Check,
  ChevronRight,
  Circle,
  Monitor,
  Globe,
  ClipboardList,
  ListChecks,
  Plus,
  X,
  RotateCcw,
  Pencil,
  Trash2,
  Terminal,
  Loader2,
  RefreshCw,
  Lock
} from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { ScrollArea } from './ui/scroll-area';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { SettingsSection } from './settings/SettingsSection';
import { SettingsRow, SettingsRows } from './settings/SettingsRow';
import { cn } from '../lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { useSettingsStore } from '../stores/settings-store';
import { useProjectStore } from '../stores/project-store';
import type { ProjectEnvConfig, AgentMcpOverride, CustomMcpServer, McpHealthCheckResult, } from '../../shared/types';
import { CustomMcpDialog } from './CustomMcpDialog';
import { useTranslation } from 'react-i18next';
import {
  AVAILABLE_MODELS,
  THINKING_LEVELS,
} from '../../shared/constants/models';
import {
  useResolvedAgentSettings,
  resolveAgentSettings as resolveAgentModelConfig,
  type AgentSettingsSource,
} from '../hooks';
import { useActiveProvider } from '../hooks/useActiveProvider';
import type { ThinkingLevel } from '../../shared/types/settings';

// Agent configuration data - mirrors AGENT_CONFIGS from backend
// Model and thinking are now dynamically read from user settings
interface AgentConfig {
  label: string;
  description: string;
  category: string;
  tools: string[];
  mcp_servers: string[];
  mcp_optional?: string[];
  // Maps to settings source - either a phase or a feature
  settingsSource: AgentSettingsSource;
}

// Helper to get model label from short name
function getModelLabel(modelShort: string): string {
  const model = AVAILABLE_MODELS.find(m => m.value === modelShort);
  return model?.label.replace('Claude ', '') || modelShort;
}

// Helper to get thinking label from level
function getThinkingLabel(level: ThinkingLevel): string {
  const thinking = THINKING_LEVELS.find(t => t.value === level);
  return thinking?.label || level;
}

const AGENT_CONFIGS: Record<string, AgentConfig> = {
  // Spec Creation Phases - all use 'spec' phase settings
  spec_gatherer: {
    label: 'Spec Gatherer',
    description: 'Collects initial requirements from user',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_researcher: {
    label: 'Spec Researcher',
    description: 'Validates external integrations and APIs',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_writer: {
    label: 'Spec Writer',
    description: 'Creates the spec.md document',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_critic: {
    label: 'Spec Critic',
    description: 'Self-critique using deep analysis',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_discovery: {
    label: 'Spec Discovery',
    description: 'Initial project discovery and analysis',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_context: {
    label: 'Spec Context',
    description: 'Builds context from existing codebase',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },
  spec_validation: {
    label: 'Spec Validation',
    description: 'Validates spec completeness and quality',
    category: 'spec',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'phase', phase: 'spec' },
  },

  // Build Phases
  planner: {
    label: 'Planner',
    description: 'Creates implementation plan with subtasks',
    category: 'build',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    mcp_optional: ['linear'],
    settingsSource: { type: 'phase', phase: 'planning' },
  },
  coder: {
    label: 'Coder',
    description: 'Implements individual subtasks',
    category: 'build',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    mcp_optional: ['linear'],
    settingsSource: { type: 'phase', phase: 'coding' },
  },

  // QA Phases
  qa_reviewer: {
    label: 'QA Reviewer',
    description: 'Validates acceptance criteria. Uses Electron or Puppeteer based on project type.',
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    mcp_optional: ['linear', 'electron', 'puppeteer'],
    settingsSource: { type: 'phase', phase: 'qa' },
  },
  qa_fixer: {
    label: 'QA Fixer',
    description: 'Fixes QA-reported issues. Uses Electron or Puppeteer based on project type.',
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    mcp_optional: ['linear', 'electron', 'puppeteer'],
    settingsSource: { type: 'phase', phase: 'qa' },
  },

  // Utility Phases - use feature settings
  commit_message: {
    label: 'Commit Message',
    description: 'Generates commit messages',
    category: 'utility',
    tools: [],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
  merge_resolver: {
    label: 'Merge Resolver',
    description: 'Resolves merge conflicts',
    category: 'utility',
    tools: [],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
  insights: {
    label: 'Insights',
    description: 'Extracts code insights',
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'insights' },
  },
  analysis: {
    label: 'Analysis',
    description: 'Codebase analysis with context lookup',
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7'],
    // Analysis uses same as insights
    settingsSource: { type: 'feature', feature: 'insights' },
  },
  pr_template_filler: {
    label: 'PR Template Filler',
    description: 'Generates AI-powered PR descriptions from templates',
    category: 'utility',
    tools: ['Read', 'Glob', 'Grep'],
    mcp_servers: [],
    settingsSource: { type: 'feature', feature: 'utility' },
  },
};

// MCP Server descriptions - accurate per backend models.py
const MCP_SERVERS: Record<string, { name: string; description: string; icon: React.ElementType; tools?: string[] }> = {
  context7: {
    name: 'Context7',
    description: 'Documentation lookup for libraries and frameworks via @upstash/context7-mcp',
    icon: Search,
    tools: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'],
  },
  'memory': {
    name: 'Memory',
    description: 'Knowledge graph for cross-session context. Requires GRAPHITI_MCP_URL env var.',
    // Note: mcp__graphiti-memory__ tool names are the external MCP server's protocol names
    icon: Brain,
    tools: [
      'mcp__graphiti-memory__search_nodes',
      'mcp__graphiti-memory__search_facts',
      'mcp__graphiti-memory__add_episode',
      'mcp__graphiti-memory__get_episodes',
      'mcp__graphiti-memory__get_entity_edge',
    ],
  },
  'auto-claude': {
    name: 'Auto Claude Tools',
    description: 'Build progress tracking, session context, discoveries & gotchas recording',
    icon: ListChecks,
    tools: [
      'mcp__auto-claude__update_subtask_status',
      'mcp__auto-claude__get_build_progress',
      'mcp__auto-claude__record_discovery',
      'mcp__auto-claude__record_gotcha',
      'mcp__auto-claude__get_session_context',
      'mcp__auto-claude__update_qa_status',
    ],
  },
  linear: {
    name: 'Linear',
    description: 'Project management via Linear API. Requires LINEAR_API_KEY env var.',
    icon: ClipboardList,
    tools: [
      'mcp__linear-server__list_teams',
      'mcp__linear-server__list_projects',
      'mcp__linear-server__list_issues',
      'mcp__linear-server__create_issue',
      'mcp__linear-server__update_issue',
      // ... and more
    ],
  },
  electron: {
    name: 'Electron MCP',
    description: 'Desktop app automation via Chrome DevTools Protocol. Requires ELECTRON_MCP_ENABLED=true.',
    icon: Monitor,
    tools: [
      'mcp__electron__get_electron_window_info',
      'mcp__electron__take_screenshot',
      'mcp__electron__send_command_to_electron',
      'mcp__electron__read_electron_logs',
    ],
  },
  puppeteer: {
    name: 'Puppeteer MCP',
    description: 'Web browser automation for non-Electron web frontends.',
    icon: Globe,
    tools: [
      'mcp__puppeteer__puppeteer_connect_active_tab',
      'mcp__puppeteer__puppeteer_navigate',
      'mcp__puppeteer__puppeteer_screenshot',
      'mcp__puppeteer__puppeteer_click',
      'mcp__puppeteer__puppeteer_fill',
      'mcp__puppeteer__puppeteer_select',
      'mcp__puppeteer__puppeteer_hover',
      'mcp__puppeteer__puppeteer_evaluate',
    ],
  },
};

// All available MCP servers that can be added to agents
const ALL_MCP_SERVERS = [
  'context7',
  'memory',
  'linear',
  'electron',
  'puppeteer',
  'auto-claude'
] as const;

// Agent categories, in display order (labels come from settings:projectPages.mcp.categories)
const CATEGORIES = ['spec', 'build', 'qa', 'utility'] as const;

/** Leading icon tile used by MCP server rows (claude.ai Connectors style) */
function ServerIconTile({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_var(--segment-thumb-ring)]">
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
    </div>
  );
}

interface ServerRowProps {
  icon: React.ElementType;
  name: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  disabled?: boolean;
}

/** An MCP server row: icon tile, name + muted description, control on the right */
function ServerRow({ icon, name, description, children, disabled = false }: ServerRowProps) {
  return (
    <div className={cn('group flex items-center gap-3 py-3', disabled && 'opacity-60')}>
      <ServerIconTile icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm text-foreground">{name}</div>
        {description && <div className="truncate text-sm text-(--nav-label-color)">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

interface AgentCardProps {
  id: string;
  config: typeof AGENT_CONFIGS[keyof typeof AGENT_CONFIGS];
  modelLabel: string;
  thinkingLabel: string;
  overrides: AgentMcpOverride | undefined;
  mcpServerStates: ProjectEnvConfig['mcpServers'];
  customServers: CustomMcpServer[];
  onAddMcp: (agentId: string, mcpId: string) => void;
  onRemoveMcp: (agentId: string, mcpId: string) => void;
}

/** One agent as a hairline row; expands in place to show its MCP servers and tools */
function AgentCard({ id, config, modelLabel, thinkingLabel, overrides, mcpServerStates, customServers, onAddMcp, onRemoveMcp }: AgentCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { t } = useTranslation(['settings']);

  // Build combined MCP server info including custom servers
  const allMcpServers = useMemo(() => {
    const servers = { ...MCP_SERVERS };
    for (const custom of customServers) {
      servers[custom.id] = {
        name: custom.name,
        description: custom.description || (custom.type === 'command' ? `${custom.command} ${custom.args?.join(' ') || ''}` : custom.url || ''),
        icon: custom.type === 'command' ? Terminal : Globe,
      };
    }
    return servers;
  }, [customServers]);

  // Calculate effective MCPs: defaults + adds - removes, then filter by project-level MCP states
  const effectiveMcps = useMemo(() => {
    const defaultMcps = [...config.mcp_servers, ...(config.mcp_optional || [])];
    const added = overrides?.add || [];
    const removed = overrides?.remove || [];
    const combinedMcps = [...new Set([...defaultMcps, ...added])].filter(mcp => !removed.includes(mcp));

    // Filter out MCPs that are disabled at project level (custom servers are always enabled)
    return combinedMcps.filter(mcp => {
      if (!mcpServerStates) return true; // No project config, show all
      // Custom servers are always available if they exist
      if (customServers.some(s => s.id === mcp)) return true;
      switch (mcp) {
        case 'context7': return mcpServerStates.context7Enabled !== false;
        case 'memory': return mcpServerStates.memoryEnabled !== false;
        case 'linear': return mcpServerStates.linearMcpEnabled !== false;
        case 'electron': return mcpServerStates.electronEnabled !== false;
        case 'puppeteer': return mcpServerStates.puppeteerEnabled !== false;
        default: return true;
      }
    });
  }, [config, overrides, mcpServerStates, customServers]);

  // Check if an MCP is a custom addition (not in defaults)
  const isCustomAdd = (mcpId: string) => {
    const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
    return !defaults.includes(mcpId) && (overrides?.add || []).includes(mcpId);
  };

  // Get removed MCPs (from defaults)
  const removedMcps = useMemo(() => {
    const defaults = [...config.mcp_servers, ...(config.mcp_optional || [])];
    return defaults.filter(mcp => (overrides?.remove || []).includes(mcp));
  }, [config, overrides]);

  // Get MCPs that can be added (not already in effective list) - includes custom servers
  const customServerIds = customServers.map(s => s.id);
  const allAvailableMcpIds = [...ALL_MCP_SERVERS, ...customServerIds];
  const availableMcps = allAvailableMcpIds.filter(
    mcp => !effectiveMcps.includes(mcp) && !removedMcps.includes(mcp) && mcp !== 'auto-claude'
  );

  return (
    <div className="py-1">
      {/* Header - clickable to expand */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-nav-hover focus-visible:shadow-(--shadow-focus)"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm text-foreground">{config.label}</span>
          <span className="truncate text-sm text-(--nav-label-color)">{config.description}</span>
        </div>
        <span className="shrink-0 text-sm text-(--nav-label-color)">
          {modelLabel} · {thinkingLabel} · {t('projectPages.mcp.mcpCount', { count: effectiveMcps.length })}
        </span>
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
          strokeWidth={1.75}
        />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="space-y-4 pb-3 pt-2">
          {/* MCP Servers */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <h4 className="text-sm text-(--nav-label-color)">{t('projectPages.mcp.agentServers')}</h4>
              {availableMcps.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setShowAddDialog(true); }}
                  className="gap-1.5"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  {t('mcp.addServer')}
                </Button>
              )}
            </div>
            {effectiveMcps.length > 0 || removedMcps.length > 0 ? (
              <div className="[&>*+*]:border-t [&>*+*]:border-settings-divider">
                {/* Active MCPs */}
                {effectiveMcps.map((server) => {
                  const serverInfo = allMcpServers[server];
                  const isAdded = isCustomAdd(server);
                  const canRemove = server !== 'auto-claude';

                  return (
                    <div key={server} className="group flex h-9 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2 text-sm">
                        <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={1.75} />
                        <span className="truncate text-foreground">{serverInfo?.name || server}</span>
                        {isAdded && <span className="text-(--nav-label-color)">· {t('mcp.added')}</span>}
                      </div>
                      {canRemove && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRemoveMcp(id, server); }}
                          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          title={t('mcp.remove')}
                          aria-label={t('mcp.remove')}
                        >
                          <X className="h-4 w-4" strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* Removed MCPs (grayed out with restore option) */}
                {removedMcps.map((server) => {
                  const serverInfo = allMcpServers[server];

                  return (
                    <div key={server} className="group flex h-9 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-(--nav-label-color)">
                        <Circle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                        <span className="truncate line-through">{serverInfo?.name || server}</span>
                        <span>· {t('mcp.removed')}</span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onAddMcp(id, server); }}
                        className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        title={t('mcp.restore')}
                        aria-label={t('mcp.restore')}
                      >
                        <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-(--nav-label-color)">{t('mcp.noMcpServers')}</p>
            )}
          </div>

          {/* Tools */}
          <div>
            <h4 className="mb-2 text-sm text-(--nav-label-color)">{t('projectPages.mcp.availableTools')}</h4>
            {config.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {config.tools.map((tool) => (
                  <span key={tool} className="rounded-md bg-segment-track px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    {tool}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-(--nav-label-color)">{t('projectPages.mcp.noTools')}</p>
            )}
          </div>
        </div>
      )}

      {/* Add MCP Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('mcp.addMcpTo', { agent: config.label })}</DialogTitle>
            <DialogDescription>{t('mcp.addMcpDescription')}</DialogDescription>
          </DialogHeader>
          <div className="-mx-6 min-h-0 space-y-1 overflow-y-auto px-6 py-4">
            {availableMcps.length > 0 ? (
              availableMcps.map((mcpId) => {
                const server = allMcpServers[mcpId];
                const ServerIcon = server?.icon || Server;
                return (
                  <button
                    type="button"
                    key={mcpId}
                    onClick={() => { onAddMcp(id, mcpId); setShowAddDialog(false); }}
                    className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-nav-hover"
                  >
                    <ServerIconTile icon={ServerIcon} />
                    <div className="min-w-0">
                      <div className="text-sm text-foreground">{server?.name || mcpId}</div>
                      <div className="text-sm text-(--nav-label-color)">{server?.description}</div>
                    </div>
                  </button>
                );
              })
            ) : (
              <p className="py-4 text-center text-sm text-(--nav-label-color)">
                {t('mcp.allMcpsAdded')}
              </p>
            )}
            {/* Also show removed MCPs that can be restored */}
            {removedMcps.length > 0 && (
              <>
                <div className="my-2 border-t border-border pt-2">
                  <p className="text-sm text-(--nav-label-color)">{t('mcp.restore')}</p>
                </div>
                {removedMcps.map((mcpId) => {
                  const server = allMcpServers[mcpId];
                  const ServerIcon = server?.icon || Server;
                  return (
                    <button
                      type="button"
                      key={mcpId}
                      onClick={() => { onAddMcp(id, mcpId); setShowAddDialog(false); }}
                      className="flex w-full items-center gap-3 rounded-lg p-2 text-left opacity-60 transition-colors hover:bg-nav-hover"
                    >
                      <ServerIconTile icon={ServerIcon} />
                      <div className="min-w-0">
                        <div className="text-sm text-foreground">{server?.name || mcpId}</div>
                        <div className="text-sm text-(--nav-label-color)">{server?.description}</div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AgentTools() {
  const { t } = useTranslation(['settings']);
  const settings = useSettingsStore((state) => state.settings);
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const [envConfig, setEnvConfig] = useState<ProjectEnvConfig | null>(null);
  const [, setIsLoading] = useState(false);

  // Custom MCP server dialog state
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  // Health status tracking for custom servers
  const [serverHealthStatus, setServerHealthStatus] = useState<Record<string, McpHealthCheckResult>>({});
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());

  // Load project env config when project changes
  useEffect(() => {
    if (selectedProjectId && selectedProject?.autoBuildPath) {
      setIsLoading(true);
      window.electronAPI.getProjectEnv(selectedProjectId)
        .then((result) => {
          if (result.success && result.data) {
            setEnvConfig(result.data);
          } else {
            setEnvConfig(null);
          }
        })
        .catch(() => {
          setEnvConfig(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      setEnvConfig(null);
    }
  }, [selectedProjectId, selectedProject?.autoBuildPath]);

  // Update MCP server toggle
  const updateMcpServer = useCallback(async (
    key: keyof NonNullable<ProjectEnvConfig['mcpServers']>,
    value: boolean
  ) => {
    if (!selectedProjectId || !envConfig) return;

    const newMcpServers = {
      ...envConfig.mcpServers,
      [key]: value,
    };

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, mcpServers: newMcpServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        mcpServers: newMcpServers,
      });
    } catch (error) {
      // Revert on error
      console.error('Failed to update MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, mcpServers: envConfig.mcpServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle adding an MCP to an agent
  const handleAddMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    // If it's in the remove list, take it out (restore)
    // Otherwise, add it to the add list
    let newOverride: AgentMcpOverride;
    if (agentOverride.remove?.includes(mcpId)) {
      newOverride = {
        ...agentOverride,
        remove: agentOverride.remove.filter(m => m !== mcpId),
      };
    } else {
      newOverride = {
        ...agentOverride,
        add: [...(agentOverride.add || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle removing an MCP from an agent
  const handleRemoveMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const agentConfig = AGENT_CONFIGS[agentId];
    const defaults = [...(agentConfig?.mcp_servers || []), ...(agentConfig?.mcp_optional || [])];
    const isDefault = defaults.includes(mcpId);

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    let newOverride: AgentMcpOverride;
    if (isDefault) {
      // It's a default MCP - add to remove list
      newOverride = {
        ...agentOverride,
        remove: [...(agentOverride.remove || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    } else {
      // It's a custom addition - remove from add list
      newOverride = {
        ...agentOverride,
        add: (agentOverride.add || []).filter(m => m !== mcpId),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle saving a custom MCP server
  const handleSaveCustomServer = useCallback(async (server: CustomMcpServer) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const existingIndex = currentServers.findIndex(s => s.id === server.id);

    let newServers: CustomMcpServer[];
    if (existingIndex >= 0) {
      // Update existing
      newServers = [...currentServers];
      newServers[existingIndex] = server;
    } else {
      // Add new
      newServers = [...currentServers, server];
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, customMcpServers: newServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
      });
    } catch (error) {
      console.error('Failed to save custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle deleting a custom MCP server
  const handleDeleteCustomServer = useCallback(async (serverId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const newServers = currentServers.filter(s => s.id !== serverId);

    // Also remove from any agent overrides that reference it
    const currentOverrides = envConfig.agentMcpOverrides || {};
    const newOverrides = { ...currentOverrides };
    for (const agentId of Object.keys(newOverrides)) {
      const override = newOverrides[agentId];
      if (override.add?.includes(serverId)) {
        newOverrides[agentId] = {
          ...override,
          add: override.add.filter(m => m !== serverId),
        };
        if (newOverrides[agentId].add?.length === 0) {
          delete newOverrides[agentId].add;
        }
        if (Object.keys(newOverrides[agentId]).length === 0) {
          delete newOverrides[agentId];
        }
      }
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? {
      ...prev,
      customMcpServers: newServers,
      agentMcpOverrides: newOverrides,
    } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to delete custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Check health of all custom MCP servers
  const checkAllServersHealth = useCallback(async () => {
    const servers = envConfig?.customMcpServers || [];
    if (servers.length === 0) return;

    for (const server of servers) {
      // Set checking status
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'checking',
          checkedAt: new Date().toISOString(),
        }
      }));

      try {
        const result = await window.electronAPI.checkMcpHealth(server);
        if (result.success && result.data) {
          setServerHealthStatus(prev => ({
            ...prev,
            [server.id]: result.data!,
          }));
        }
      } catch (_error) {
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: 'unknown',
            message: 'Health check failed',
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    }
  }, [envConfig?.customMcpServers]);

  // Check health when custom servers change
  useEffect(() => {
    if (envConfig?.customMcpServers && envConfig.customMcpServers.length > 0) {
      checkAllServersHealth();
    }
  }, [envConfig?.customMcpServers, checkAllServersHealth]);

  // Test a single server connection (full test)
  const handleTestConnection = useCallback(async (server: CustomMcpServer) => {
    setTestingServers(prev => new Set(prev).add(server.id));

    try {
      const result = await window.electronAPI.testMcpConnection(server);
      if (result.success && result.data) {
        // Update health status based on test result
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: result.data?.success ? 'healthy' : 'unhealthy',
            message: result.data?.message,
            responseTime: result.data?.responseTime,
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    } catch (_error) {
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'unhealthy',
          message: 'Connection test failed',
          checkedAt: new Date().toISOString(),
        }
      }));
    } finally {
      setTestingServers(prev => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }, []);

  // Resolve agent settings using the centralized utility, scoped to the active provider
  // Resolution order: custom overrides -> selected profile's config -> global defaults
  const { provider: currentProvider } = useActiveProvider();
  const { phaseModels, phaseThinking, featureModels, featureThinking } = useResolvedAgentSettings(settings, currentProvider ?? undefined);

  // Get MCP server states for display
  const mcpServers = envConfig?.mcpServers || {};

  // Count enabled MCP servers
  const enabledCount = [
    mcpServers.context7Enabled !== false,
    mcpServers.memoryEnabled && envConfig?.memoryProviderConfig,
    mcpServers.linearMcpEnabled !== false && envConfig?.linearEnabled,
    mcpServers.electronEnabled,
    mcpServers.puppeteerEnabled,
    true, // auto-claude always enabled
  ].filter(Boolean).length;

  // Resolve model and thinking for an agent based on its settings source
  const getAgentModelConfig = useMemo(() => {
    return (config: AgentConfig): { model: string; thinking: ThinkingLevel } => {
      return resolveAgentModelConfig(config.settingsSource, { phaseModels, phaseThinking, featureModels, featureThinking });
    };
  }, [phaseModels, phaseThinking, featureModels, featureThinking]);

  // Group agents by category
  const agentsByCategory = Object.entries(AGENT_CONFIGS).reduce(
    (acc, [id, config]) => {
      const category = config.category;
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({ id, config });
      return acc;
    },
    {} as Record<string, Array<{ id: string; config: typeof AGENT_CONFIGS[keyof typeof AGENT_CONFIGS] }>>
  );

  const renderCustomServerStatus = (server: CustomMcpServer) => {
    const health = serverHealthStatus[server.id];
    if (testingServers.has(server.id) || health?.status === 'checking') {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" strokeWidth={1.75} />;
    }
    switch (health?.status) {
      case 'healthy':
        return <Check className="h-4 w-4 text-success" strokeWidth={1.75} aria-label={t('settings:mcp.status.healthy')} />;
      case 'needs_auth':
        return <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-label={t('settings:mcp.status.needsAuth')} />;
      case 'unhealthy':
        return <X className="h-4 w-4 text-destructive" strokeWidth={1.75} aria-label={t('settings:mcp.status.unhealthy')} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[832px] px-7 pb-10 pt-4">
          {/* No project selected message */}
          {!selectedProject && (
            <SettingsSection title={t('settings:projectSections.mcp.title')}>
              <p className="text-sm text-(--nav-label-color)">{t('settings:mcp.noProjectSelectedDescription')}</p>
            </SettingsSection>
          )}

          {/* Project not initialized message */}
          {selectedProject && !selectedProject.autoBuildPath && (
            <SettingsSection title={t('settings:projectSections.mcp.title')}>
              <p className="text-sm text-(--nav-label-color)">{t('settings:mcp.projectNotInitializedDescription')}</p>
            </SettingsSection>
          )}

          {/* MCP Server Configuration */}
          {envConfig && (
            <>
              <SettingsSection title={t('settings:projectPages.mcp.serversTitle')}>
                <p className="-mt-2 mb-1 text-sm text-(--nav-label-color)">
                  {t('settings:mcp.serversEnabled', { count: enabledCount })} · {t('settings:mcp.configurationHint')}
                </p>
                <SettingsRows>
                  <ServerRow
                    icon={Search}
                    name={t('settings:mcp.servers.context7.name')}
                    description={t('settings:mcp.servers.context7.description')}
                  >
                    <Switch
                      checked={mcpServers.context7Enabled !== false}
                      onCheckedChange={(checked) => updateMcpServer('context7Enabled', checked)}
                      aria-label={t('settings:mcp.servers.context7.name')}
                    />
                  </ServerRow>
                  <ServerRow
                    icon={Brain}
                    name={t('settings:mcp.servers.memory.name')}
                    description={
                      envConfig.memoryProviderConfig
                        ? t('settings:mcp.servers.memory.description')
                        : t('settings:mcp.servers.memory.notConfigured')
                    }
                  >
                    <Switch
                      checked={mcpServers.memoryEnabled !== false && !!envConfig.memoryProviderConfig}
                      onCheckedChange={(checked) => updateMcpServer('memoryEnabled', checked)}
                      disabled={!envConfig.memoryProviderConfig}
                      aria-label={t('settings:mcp.servers.memory.name')}
                    />
                  </ServerRow>
                  <ServerRow
                    icon={ClipboardList}
                    name={t('settings:mcp.servers.linear.name')}
                    description={
                      envConfig.linearEnabled
                        ? t('settings:mcp.servers.linear.description')
                        : t('settings:mcp.servers.linear.notConfigured')
                    }
                  >
                    <Switch
                      checked={mcpServers.linearMcpEnabled !== false && envConfig.linearEnabled}
                      onCheckedChange={(checked) => updateMcpServer('linearMcpEnabled', checked)}
                      disabled={!envConfig.linearEnabled}
                      aria-label={t('settings:mcp.servers.linear.name')}
                    />
                  </ServerRow>
                  <ServerRow
                    icon={ListChecks}
                    name={t('settings:mcp.servers.autoClaude.name')}
                    description={`${t('settings:mcp.servers.autoClaude.description')} (${t('settings:mcp.alwaysEnabled')})`}
                  >
                    <Switch checked={true} disabled aria-label={t('settings:mcp.servers.autoClaude.name')} />
                  </ServerRow>
                </SettingsRows>
              </SettingsSection>

              {/* Browser Automation Section */}
              <SettingsSection title={t('settings:mcp.browserAutomation')}>
                <SettingsRows>
                  <ServerRow
                    icon={Monitor}
                    name={t('settings:mcp.servers.electron.name')}
                    description={t('settings:mcp.servers.electron.description')}
                  >
                    <Switch
                      checked={mcpServers.electronEnabled === true}
                      onCheckedChange={(checked) => updateMcpServer('electronEnabled', checked)}
                      aria-label={t('settings:mcp.servers.electron.name')}
                    />
                  </ServerRow>
                  <ServerRow
                    icon={Globe}
                    name={t('settings:mcp.servers.puppeteer.name')}
                    description={t('settings:mcp.servers.puppeteer.description')}
                  >
                    <Switch
                      checked={mcpServers.puppeteerEnabled === true}
                      onCheckedChange={(checked) => updateMcpServer('puppeteerEnabled', checked)}
                      aria-label={t('settings:mcp.servers.puppeteer.name')}
                    />
                  </ServerRow>
                </SettingsRows>
              </SettingsSection>

              {/* Custom MCP Servers Section */}
              <SettingsSection title={t('settings:mcp.customServers')}>
                <SettingsRows>
                  {envConfig.customMcpServers?.map((server) => {
                    const health = serverHealthStatus[server.id];
                    const isTesting = testingServers.has(server.id);

                    return (
                      <ServerRow
                        key={server.id}
                        icon={server.type === 'command' ? Terminal : Globe}
                        name={
                          <span className="flex items-center gap-2">
                            {server.name}
                            {health?.responseTime && (
                              <span className="text-(--nav-label-color)">{health.responseTime}ms</span>
                            )}
                            {renderCustomServerStatus(server)}
                          </span>
                        }
                        description={
                          health?.message ||
                          (server.type === 'command' ? `${server.command} ${server.args?.join(' ') || ''}` : server.url)
                        }
                      >
                        <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => { setEditingCustomServer(server); setShowCustomMcpDialog(true); }}
                            className="h-8 w-8 text-muted-foreground"
                            title={t('settings:projectPages.mcp.edit')}
                            aria-label={t('settings:projectPages.mcp.edit')}
                          >
                            <Pencil className="h-4 w-4" strokeWidth={1.75} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteCustomServer(server.id)}
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            title={t('settings:projectPages.mcp.delete')}
                            aria-label={t('settings:projectPages.mcp.delete')}
                          >
                            <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                          </Button>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTestConnection(server)}
                          disabled={isTesting}
                          className="gap-1.5"
                        >
                          {isTesting ? (
                            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                          )}
                          {t('settings:mcp.testConnection')}
                        </Button>
                      </ServerRow>
                    );
                  })}
                  <SettingsRow
                    label={t('settings:mcp.addCustomServer')}
                    description={
                      (envConfig.customMcpServers?.length ?? 0) === 0
                        ? t('settings:mcp.noCustomServers')
                        : t('settings:mcp.customServerDescription')
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setEditingCustomServer(null); setShowCustomMcpDialog(true); }}
                      className="gap-1.5"
                    >
                      <Plus className="h-4 w-4" strokeWidth={1.75} />
                      {t('settings:projectPages.mcp.add')}
                    </Button>
                  </SettingsRow>
                </SettingsRows>
              </SettingsSection>
            </>
          )}

          {/* Agents, grouped by category */}
          {CATEGORIES.map((categoryId) => {
            const agents = agentsByCategory[categoryId] || [];
            if (agents.length === 0) return null;

            return (
              <SettingsSection key={categoryId} title={t(`settings:projectPages.mcp.categories.${categoryId}`)}>
                <SettingsRows>
                  {agents.map(({ id, config }) => {
                    const { model, thinking } = getAgentModelConfig(config);
                    return (
                      <AgentCard
                        key={id}
                        id={id}
                        config={config}
                        modelLabel={getModelLabel(model)}
                        thinkingLabel={getThinkingLabel(thinking)}
                        overrides={envConfig?.agentMcpOverrides?.[id]}
                        mcpServerStates={envConfig?.mcpServers}
                        customServers={envConfig?.customMcpServers || []}
                        onAddMcp={handleAddMcp}
                        onRemoveMcp={handleRemoveMcp}
                      />
                    );
                  })}
                </SettingsRows>
              </SettingsSection>
            );
          })}
        </div>
      </ScrollArea>

      {/* Custom MCP Server Dialog */}
      <CustomMcpDialog
        open={showCustomMcpDialog}
        onOpenChange={setShowCustomMcpDialog}
        server={editingCustomServer}
        existingIds={(envConfig?.customMcpServers || []).map(s => s.id)}
        onSave={handleSaveCustomServer}
      />
    </div>
  );
}
