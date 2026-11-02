import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../stores/settings-store';
import { BUILTIN_CONNECTOR_META, commandMissingText } from '../components/settings/connector-meta';
import { getUsableCustomServers } from '../../shared/utils/mcp-connectors';
import type { McpAvailability } from '../../shared/types';

/**
 * Whether connectors' MCP servers can start (src/main/mcp-availability.ts), kept for the app
 * session and updated as the main process finishes checking them
 */
const known = new Map<string, McpAvailability>();
const subscribers = new Set<() => void>();
let listening = false;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.electronAPI.onMcpAvailabilityChanged((id, availability) => {
    known.set(id, availability);
    notify();
  });
}

/** Why a connector can't be switched on yet, and the command that fixes it when there is one */
export interface McpUnavailable {
  reason: string;
  fixCommand?: string;
  /** What to do about it, for the switch's tooltip (where the row already shows the reason) */
  tip?: string;
}

/**
 * Why a connector can't be switched on yet (its server is being prepared, its command isn't
 * installed, or it failed to start), or null when it can be used. Its switches are off and
 * disabled while there is a reason
 */
export function useMcpUnavailableReason(): (connectorId: string) => McpUnavailable | null {
  const { t } = useTranslation(['settings']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  const [, setVersion] = useState(0);
  const ids = [...BUILTIN_CONNECTOR_META.map(({ id }) => id), ...getUsableCustomServers(connectors).map((server) => server.id)];
  // Edited connection details (and another browser for Puppeteer) are checked again
  const browser = connectors?.puppeteerBrowser;
  const key = JSON.stringify([
    ids,
    getUsableCustomServers(connectors).map(({ id, type, command, args, url, headers }) => ({ id, type, command, args, url, headers })),
    browser ? [browser.id, browser.executablePath] : null,
    // The main process keeps the settings each ask carries (the chosen browser and its switch)
    connectors?.puppeteerEnabled === true,
  ]);

  useEffect(() => {
    const update = () => setVersion((v) => v + 1);
    subscribers.add(update);
    listen();
    void window.electronAPI.getMcpAvailability(ids).then((result) => {
      if (!result.success || !result.data) return;
      for (const [id, availability] of Object.entries(result.data)) known.set(id, availability);
      notify();
    }).catch(() => undefined);
    return () => {
      subscribers.delete(update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the ids and their details
  }, [key]);

  return (connectorId) => {
    const availability = known.get(connectorId) ?? { state: 'preparing' };
    if (availability.state === 'ready') return null;
    if (availability.state === 'preparing') return { reason: t('settings:mcp.preparing') };
    if (availability.missingCommand) return { reason: commandMissingText(t, availability.missingCommand) };
    if (availability.browserOpen) {
      const name = browser ? t(`settings:mcp.browserProfile.browsers.${browser.browser}`) : '';
      return {
        reason: t('settings:mcp.browserProfile.browserOpen', { browser: name }),
        tip: t('settings:mcp.browserProfile.closeBrowser', { browser: name }),
      };
    }
    return { reason: t('settings:mcp.unavailable', { reason: availability.message ?? '' }), fixCommand: availability.fixCommand };
  };
}
