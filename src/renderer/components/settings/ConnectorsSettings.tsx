/**
 * Connectors (app settings): the default MCP servers for new tasks. Built-in servers have on/off
 * switches; custom servers are added here, must pass a connection test, then switch on/off.
 * Tasks copy these defaults when created and can change them per task.
 */

import { ListChecks, Loader2, Lock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { BUILTIN_CONNECTOR_META, ConnectorRow, customServerIcon } from './ConnectorRow';
import { CustomMcpDialog } from '../CustomMcpDialog';
import { useProjectStore } from '../../stores/project-store';
import { getDefaultMcpConnectorIds } from '../../../shared/utils/mcp-connectors';
import type { AppSettings, CustomMcpServer, McpConnectorSettings, McpHealthCheckResult } from '../../../shared/types';

interface ConnectorsSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const BUILTIN_SETTING_KEY = {
  context7: 'context7Enabled',
  memory: 'memoryEnabled',
  electron: 'electronEnabled',
  puppeteer: 'puppeteerEnabled',
} as const;

export function ConnectorsSettings({ settings, onSettingsChange }: ConnectorsSettingsProps) {
  const { t } = useTranslation(['settings']);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);

  // Async handlers (connection tests) must update the latest settings, not the ones they started with
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const connectors = settings.mcpConnectors ?? {};
  const customServers = connectors.customServers ?? [];

  const updateConnectors = useCallback((update: (current: McpConnectorSettings) => McpConnectorSettings) => {
    const latest = settingsRef.current;
    const next = { ...latest, mcpConnectors: update(latest.mcpConnectors ?? {}) };
    settingsRef.current = next;
    onSettingsChange(next);
  }, [onSettingsChange]);

  // One-time move: connectors used to be per project; seed the defaults from the selected project
  useEffect(() => {
    if (settings.mcpConnectors !== undefined || !selectedProjectId) return;
    let cancelled = false;
    window.electronAPI.getProjectEnv(selectedProjectId).then((result) => {
      const env = result.success ? result.data : null;
      if (cancelled || !env || settingsRef.current.mcpConnectors !== undefined) return;
      if (!env.mcpServers && !env.customMcpServers?.length) return;
      updateConnectors(() => ({
        context7Enabled: env.mcpServers?.context7Enabled,
        memoryEnabled: env.mcpServers?.memoryEnabled,
        electronEnabled: env.mcpServers?.electronEnabled,
        puppeteerEnabled: env.mcpServers?.puppeteerEnabled,
        customServers: env.customMcpServers,
      }));
    }).catch(() => {
      // Nothing to carry over
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, settings.mcpConnectors, updateConnectors]);

  // Custom MCP server dialog state
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  // Health status tracking for custom servers
  const [serverHealthStatus, setServerHealthStatus] = useState<Record<string, McpHealthCheckResult>>({});
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());

  const handleSaveCustomServer = useCallback((server: CustomMcpServer) => {
    updateConnectors((current) => {
      const currentServers = current.customServers ?? [];
      const existingIndex = currentServers.findIndex(s => s.id === server.id);
      let newServers: CustomMcpServer[];
      if (existingIndex >= 0) {
        // Keep its tested/enabled state unless the connection details changed, in which case it
        // has to pass a test again
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
        newServers = [...currentServers, server];
      }
      return { ...current, customServers: newServers };
    });
  }, [updateConnectors]);

  const handleDeleteCustomServer = useCallback((serverId: string) => {
    updateConnectors((current) => ({
      ...current,
      customServers: (current.customServers ?? []).filter(s => s.id !== serverId),
    }));
  }, [updateConnectors]);

  // Check health of all custom MCP servers
  const checkAllServersHealth = useCallback(async (servers: CustomMcpServer[]) => {
    for (const server of servers) {
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: { serverId: server.id, status: 'checking', checkedAt: new Date().toISOString() },
      }));
      try {
        const result = await window.electronAPI.checkMcpHealth(server);
        if (result.success && result.data) {
          setServerHealthStatus(prev => ({ ...prev, [server.id]: result.data! }));
        }
      } catch (_error) {
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: { serverId: server.id, status: 'unknown', message: 'Health check failed', checkedAt: new Date().toISOString() },
        }));
      }
    }
  }, []);

  // Check health when the custom servers' connection details change
  const healthKey = JSON.stringify(customServers.map(({ id, type, command, args, url }) => ({ id, type, command, args, url })));
  useEffect(() => {
    if (customServers.length > 0) void checkAllServersHealth(customServers);
    // Re-check only when connection details change (not on name, description or switch edits)
  }, [healthKey, checkAllServersHealth]);

  // Test a single server connection (full test)
  const handleTestConnection = useCallback(async (server: CustomMcpServer) => {
    setTestingServers(prev => new Set(prev).add(server.id));
    try {
      const result = await window.electronAPI.testMcpConnection(server);
      // A passing test turns the Test button into an on/off switch for good
      if (result.success && result.data?.success && !server.verified) {
        handleSaveCustomServer({ ...server, verified: true, enabled: true });
      }
      if (result.success && result.data) {
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: result.data?.success ? 'healthy' : 'unhealthy',
            message: result.data?.message,
            responseTime: result.data?.responseTime,
            checkedAt: new Date().toISOString(),
          },
        }));
      }
    } catch (_error) {
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: { serverId: server.id, status: 'unhealthy', message: 'Connection test failed', checkedAt: new Date().toISOString() },
      }));
    } finally {
      setTestingServers(prev => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }, [handleSaveCustomServer]);

  // Enabled count includes Auto Claude's own server, which is always on
  const enabledCount = getDefaultMcpConnectorIds(connectors).length + 1;

  const renderCustomServerStatus = (server: CustomMcpServer) => {
    const health = serverHealthStatus[server.id];
    if (testingServers.has(server.id) || health?.status === 'checking') {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" strokeWidth={1.75} />;
    }
    if (health?.status === 'needs_auth') {
      return <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-label={t('settings:mcp.status.needsAuth')} />;
    }
    return null;
  };

  return (
    <>
      <SettingsSection title={t('settings:projectPages.mcp.serversTitle')}>
        <p className="-mt-2 mb-1 text-sm text-(--nav-label-color)">
          {t('settings:mcp.serversEnabled', { count: enabledCount })} · {t('settings:mcp.defaultsHint')}
        </p>
        <SettingsRows>
          {BUILTIN_CONNECTOR_META.map(({ id, icon, qaOnly }) => {
            const key = BUILTIN_SETTING_KEY[id];
            // Context7 and Memory default on; browser automation defaults off
            const checked = qaOnly ? connectors[key] === true : connectors[key] !== false;
            const description = t(`settings:mcp.servers.${id}.description`);
            return (
              <ConnectorRow
                key={id}
                icon={icon}
                name={t(`settings:mcp.servers.${id}.name`)}
                description={qaOnly ? `${description} (${t('settings:mcp.qaAgentsOnly')})` : description}
              >
                <Switch
                  checked={checked}
                  onCheckedChange={(value) => updateConnectors((current) => ({ ...current, [key]: value }))}
                  aria-label={t(`settings:mcp.servers.${id}.name`)}
                />
              </ConnectorRow>
            );
          })}
          <ConnectorRow
            icon={ListChecks}
            name={t('settings:mcp.servers.autoClaude.name')}
            description={`${t('settings:mcp.servers.autoClaude.description')} (${t('settings:mcp.alwaysEnabled')})`}
          >
            <Switch checked={true} disabled aria-label={t('settings:mcp.servers.autoClaude.name')} />
          </ConnectorRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title={t('settings:mcp.customServers')}>
        <SettingsRows>
          {customServers.map((server) => {
            const health = serverHealthStatus[server.id];
            const isTesting = testingServers.has(server.id);

            return (
              <ConnectorRow
                key={server.id}
                icon={customServerIcon(server)}
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
              </ConnectorRow>
            );
          })}
          <SettingsRow
            label={t('settings:mcp.addCustomServer')}
            description={
              customServers.length === 0
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

      <CustomMcpDialog
        open={showCustomMcpDialog}
        onOpenChange={setShowCustomMcpDialog}
        server={editingCustomServer}
        existingIds={customServers.map(s => s.id)}
        onSave={handleSaveCustomServer}
      />
    </>
  );
}
