/**
 * Connector details shared by the connector rows, the task dialog, the chat's MCP menu and its
 * tool rows. Kept out of ConnectorRow.tsx so that file only exports components (Fast Refresh)
 */

import { Context7Icon, ElectronIcon, McpIcon, PuppeteerIcon } from '../icons/app-icons';
import type { CustomMcpServer } from '../../../shared/types';

/** Built-in connectors that can be switched on or off: icon and translation keys (settings ns) */
export const BUILTIN_CONNECTOR_META: { id: 'context7' | 'electron' | 'puppeteer'; icon: React.ElementType; /** Off unless switched on (browser automation) */ defaultOff?: boolean }[] = [
  { id: 'context7', icon: Context7Icon },
  { id: 'electron', icon: ElectronIcon, defaultOff: true },
  { id: 'puppeteer', icon: PuppeteerIcon, defaultOff: true },
];

/** Icon for a custom server: the MCP mark */
export function customServerIcon(_server: CustomMcpServer): React.ElementType {
  return McpIcon;
}

/** A custom server's own description, otherwise its command or URL */
export function customServerSummary(server: CustomMcpServer): string {
  return server.description?.trim()
    || (server.type === 'command' ? `${server.command} ${server.args?.join(' ') || ''}`.trim() : server.url || '');
}

/** Why a connector can't be used: the command its server needs isn't installed */
export function commandMissingText(t: (key: string, options?: Record<string, unknown>) => string, command: string): string {
  return t('settings:mcp.commandMissing', { command: command === 'npx' ? t('settings:mcp.npxCommand') : command });
}
