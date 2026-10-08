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
  ChevronDown,
  Monitor,
  Globe,
  ListChecks,
  Plus,
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
import { SettingsRow, SettingsRows, SETTINGS_MENU_TRIGGER_CLASS } from './settings/SettingsRow';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn } from '../lib/utils';
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
    settingsSource: { type: 'phase', phase: 'planning' },
  },
  coder: {
    label: 'Coder',
    description: 'Implements individual subtasks',
    category: 'build',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    settingsSource: { type: 'phase', phase: 'coding' },
  },

  // QA Phases
  qa_reviewer: {
    label: 'QA Reviewer',
    description: 'Validates acceptance criteria. Uses Electron or Puppeteer based on project type',
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
    settingsSource: { type: 'phase', phase: 'qa' },
  },
  qa_fixer: {
    label: 'QA Fixer',
    description: 'Fixes QA-reported issues. Uses Electron or Puppeteer based on project type',
    category: 'qa',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'],
    mcp_servers: ['context7', 'memory', 'auto-claude'],
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
    description: 'Knowledge graph for cross-session context. Requires GRAPHITI_MCP_URL env var',
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
  electron: {
    name: 'Electron MCP',
    description: 'Desktop app automation via Chrome DevTools Protocol. Requires ELECTRON_MCP_ENABLED=true',
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
    description: 'Web browser automation for non-Electron web frontends',
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

// Agent categories, in display order (labels come from settings:projectPages.mcp.categories)
const CATEGORIES = ['spec', 'build', 'qa', 'utility'] as const;

// Browser automation servers are only offered to the QA agents
const QA_AGENT_IDS = ['qa_reviewer', 'qa_fixer'];
const BROWSER_MCP_SERVERS = ['electron', 'puppeteer'];

/**
 * The MCP servers an agent can use: every server (built-in and custom) except browser
 * automation, which only QA agents get. Auto Claude's own server stays with the agents built
 * around it (planner, coder, QA). Agents use all of these that are enabled for the project,
 * minus the ones removed for that agent.
 */
function getAgentEligibleMcps(agentId: string, customServerIds: string[]): string[] {
  const config = AGENT_CONFIGS[agentId];
  return [
    'context7',
    'memory',
    ...(QA_AGENT_IDS.includes(agentId) ? BROWSER_MCP_SERVERS : []),
    ...customServerIds,
    ...(config?.mcp_servers.includes('auto-claude') ? ['auto-claude'] : []),
  ];
}

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
  /** Whether each server is switched on for the project */
  isEnabledForProject: (mcpId: string) => boolean;
  customServers: CustomMcpServer[];
  onAddMcp: (agentId: string, mcpId: string) => void;
  onRemoveMcp: (agentId: string, mcpId: string) => void;
}

/**
 * One agent as a settings row (like the Accounts page's provider rows): label, description,
 * model and tool tags on the left; a dropdown on the right with its MCP servers as a checklist.
 * Enabled servers are on by default; unchecking removes one for this agent.
 */
function AgentCard({ id, config, modelLabel, thinkingLabel, overrides, isEnabledForProject, customServers, onAddMcp, onRemoveMcp }: AgentCardProps) {
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

  // Every eligible server, checked when it's enabled for the project and not removed for this agent
  const serverItems = useMemo(() => {
    const removed = overrides?.remove || [];
    return getAgentEligibleMcps(id, customServers.map(s => s.id)).map((server) => {
      const enabled = isEnabledForProject(server);
      return { server, enabled, checked: enabled && !removed.includes(server) };
    });
  }, [id, overrides, customServers, isEnabledForProject]);
  const activeCount = serverItems.filter(item => item.checked).length;

  return (
    <SettingsRow
      label={config.label}
      description={
        <>
          {config.description}
          <span className="mt-0.5 block text-xs">{modelLabel} · {thinkingLabel}</span>
          {config.tools.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1" aria-label={t('projectPages.mcp.availableTools')}>
              {config.tools.map((tool) => (
                <span key={tool} className="rounded-md bg-segment-track px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {tool}
                </span>
              ))}
            </span>
          )}
        </>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('projectPages.mcp.agentMenu', { agent: config.label })}
          className={SETTINGS_MENU_TRIGGER_CLASS}
        >
          {t('projectPages.mcp.mcpCount', { count: activeCount })}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="text-xs font-normal text-(--nav-label-color)">
            {t('projectPages.mcp.agentServers')}
          </DropdownMenuLabel>
          {serverItems.length > 0 ? (
            serverItems.map(({ server, enabled, checked }) => {
              const serverInfo = allMcpServers[server];
              // Auto Claude's own server is always on; servers off for the project can't be used
              const locked = server === 'auto-claude' || !enabled;
              const note = enabled ? undefined : t('projectPages.mcp.offForProject');
              return (
                <DropdownMenuCheckboxItem
                  key={server}
                  checked={checked}
                  disabled={locked}
                  // Keep the menu open so several servers can be toggled
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(value) => (value ? onAddMcp(id, server) : onRemoveMcp(id, server))}
                  className="cursor-pointer"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {serverInfo?.name || server}
                      {note && <span className="text-(--nav-label-color)"> · {note}</span>}
                    </div>
                    {serverInfo?.description && (
                      <div className="truncate text-[0.8125rem] text-(--nav-label-color)">{serverInfo.description}</div>
                    )}
                  </div>
                </DropdownMenuCheckboxItem>
              );
            })
          ) : (
            <DropdownMenuItem disabled className="text-(--nav-label-color)">{t('mcp.noMcpServers')}</DropdownMenuItem>
          )}

        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
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

    const customIds = (envConfig.customMcpServers || []).map(s => s.id);
    const isDefault = getAgentEligibleMcps(agentId, customIds).includes(mcpId);

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
      // Update existing. Keep its tested/enabled state unless the connection details changed,
      // in which case it has to pass a test again
      const existing = currentServers[existingIndex];
      const connectionChanged = (['type', 'command', 'url'] as const).some(k => existing[k] !== server[k])
        || JSON.stringify(existing.args ?? []) !== JSON.stringify(server.args ?? [])
        || JSON.stringify(existing.headers ?? {}) !== JSON.stringify(server.headers ?? {});
      newServers = [...currentServers];
      newServers[existingIndex] = {
        ...server,
        verified: connectionChanged ? false : server.verified ?? existing.verified,
        enabled: server.enabled ?? existing.enabled,
      };
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
      // A passing test turns the Test button into an on/off switch for good
      if (result.success && result.data?.success && !server.verified) {
        await handleSaveCustomServer({ ...server, verified: true, enabled: true });
      }
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
  }, [handleSaveCustomServer]);

  // Resolve agent settings using the centralized utility, scoped to the active provider
  // Resolution order: custom overrides -> selected profile's config -> global defaults
  const { provider: currentProvider } = useActiveProvider();
  const { phaseModels, phaseThinking, featureModels, featureThinking } = useResolvedAgentSettings(settings, currentProvider ?? undefined);

  // Get MCP server states for display
  const mcpServers = envConfig?.mcpServers || {};

  // Count enabled MCP servers
  // Whether a server is switched on for the project
  const isEnabledForProject = useCallback((mcpId: string) => {
    switch (mcpId) {
      case 'context7': return mcpServers.context7Enabled !== false;
      case 'memory': return mcpServers.memoryEnabled !== false && !!envConfig?.memoryProviderConfig;
      case 'electron': return mcpServers.electronEnabled === true;
      case 'puppeteer': return mcpServers.puppeteerEnabled === true;
      // Custom servers: on unless switched off
      default: return envConfig?.customMcpServers?.find(s => s.id === mcpId)?.enabled !== false;
    }
  }, [mcpServers, envConfig?.memoryProviderConfig, envConfig?.customMcpServers]);

  const enabledCount = [
    mcpServers.context7Enabled !== false,
    mcpServers.memoryEnabled && envConfig?.memoryProviderConfig,
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
        return null;
      case 'needs_auth':
        return <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-label={t('settings:mcp.status.needsAuth')} />;
      case 'unhealthy':
        return null;
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
                    icon={ListChecks}
                    name={t('settings:mcp.servers.autoClaude.name')}
                    description={`${t('settings:mcp.servers.autoClaude.description')} (${t('settings:mcp.alwaysEnabled')})`}
                  >
                    <Switch checked={true} disabled aria-label={t('settings:mcp.servers.autoClaude.name')} />
                  </ServerRow>
                  {/* Browser automation: offered to the QA agents only */}
                  <ServerRow
                    icon={Monitor}
                    name={t('settings:mcp.servers.electron.name')}
                    description={`${t('settings:mcp.servers.electron.description')} (${t('settings:mcp.qaAgentsOnly')})`}
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
                    description={`${t('settings:mcp.servers.puppeteer.description')} (${t('settings:mcp.qaAgentsOnly')})`}
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
                        // The server's own description when set, otherwise its status or connection
                        description={
                          server.description?.trim() ||
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
                        {/* Untested servers need a passing test first; after that, an on/off switch */}
                        {server.verified ? (
                          <Switch
                            checked={server.enabled !== false}
                            onCheckedChange={(checked) => handleSaveCustomServer({ ...server, enabled: checked })}
                            aria-label={server.name}
                          />
                        ) : (
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
                        )}
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
                        isEnabledForProject={isEnabledForProject}
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
