/**
 * MCP connectors: the built-in servers plus the user's tested custom servers. Settings > Connectors
 * holds the defaults; each task stores the ids enabled for it (TaskMetadata.mcpConnectors).
 */

import type { McpConnectorSettings } from '../types/settings';
import type { CustomMcpServer } from '../types/project';
import type { PlaywrightBrowserChoice } from '../types/browser-profiles';

/** Custom servers that can be used: only ones that passed a connection test */
export function getUsableCustomServers(settings: McpConnectorSettings | undefined): CustomMcpServer[] {
  return (settings?.customServers ?? []).filter((server) => server.verified);
}

/** Ids of the connectors switched on in the defaults */
export function getDefaultMcpConnectorIds(settings: McpConnectorSettings | undefined): string[] {
  return [
    ...(settings?.context7Enabled !== false ? ['context7'] : []),
    ...(settings?.electronEnabled === true ? ['electron'] : []),
    ...(settings?.playwrightEnabled === true ? ['playwright'] : []),
    ...getUsableCustomServers(settings)
      .filter((server) => server.enabled !== false)
      .map((server) => server.id),
  ];
}

/**
 * The browser profile a task's Playwright connector uses: the task's own choice when it made one
 * (null: Playwright's own Chromium), otherwise the one in Settings > Connectors (unset: Playwright's
 * own Chromium)
 */
export function getTaskPlaywrightBrowser(
  taskChoice: PlaywrightBrowserChoice | null | undefined,
  settings: McpConnectorSettings | undefined
): PlaywrightBrowserChoice | undefined {
  return taskChoice !== undefined ? taskChoice ?? undefined : settings?.playwrightBrowser;
}

/*
 * Stored data from before the browser connector moved from Puppeteer's MCP server to Playwright's:
 * its id was `puppeteer`, its settings `puppeteerEnabled` / `puppeteerBrowser`, a task's pick
 * `TaskMetadata.puppeteerBrowser`, and Puppeteer's own Firefox was the choice `puppeteer:firefox`.
 * Renamed where the data is read (settings file, task metadata, drafts, chats), so nothing else
 * needs to know the old names
 */
const LEGACY_CONNECTOR_IDS: ReadonlyMap<string, string> = new Map([['puppeteer', 'playwright']]);
const LEGACY_MANAGED_PREFIX = 'puppeteer:';

/** The built-in connectors' ids (Settings > Connectors); a custom server never takes one */
export const BUILTIN_MCP_CONNECTOR_IDS: readonly string[] = ['context7', 'electron', 'playwright'];

/** The ids of the custom servers in the settings */
export function customMcpServerIds(settings: McpConnectorSettings | undefined): string[] {
  return (settings?.customServers ?? []).map((server) => server.id);
}

/**
 * Connector ids with old ids renamed (and each id once). An id a custom server has now
 * (`customServerIds`: a server the user added later under the old name) is that server's, never renamed
 */
export function normalizeMcpConnectorIds(ids: string[], customServerIds: Iterable<string> = []): string[] {
  const custom = new Set(customServerIds);
  return [...new Set(ids.map((id) => (custom.has(id) ? id : LEGACY_CONNECTOR_IDS.get(id) ?? id)))];
}

/** A stored browser choice with an old managed id renamed (Puppeteer's Firefox -> Playwright's) */
export function migrateBrowserChoice<T extends PlaywrightBrowserChoice | null | undefined>(choice: T): T {
  if (!choice || typeof choice !== 'object' || typeof choice.id !== 'string' || !choice.id.startsWith(LEGACY_MANAGED_PREFIX)) return choice;
  return { ...choice, id: `playwright:${choice.id.slice(LEGACY_MANAGED_PREFIX.length)}` };
}

/** Move an old field to its new name (the new one wins when both are there); whether anything changed */
function renameField(record: Record<string, unknown>, from: string, to: string): boolean {
  if (!Object.hasOwn(record, from)) return false;
  if (!Object.hasOwn(record, to)) record[to] = record[from];
  delete record[from];
  return true;
}

/**
 * Custom servers with a built-in connector's id (added as "Playwright" before that was a built-in),
 * given a free one (`playwright-custom`), in place: a built-in id always means the built-in.
 * Whether any changed
 */
function moveCustomServersOffBuiltinIds(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.customServers)) return false;
  const servers = record.customServers as Array<{ id?: unknown }>;
  const taken = new Set([...BUILTIN_MCP_CONNECTOR_IDS, ...servers.map((server) => server?.id)]);
  let changed = false;
  record.customServers = servers.map((server) => {
    if (!server || typeof server.id !== 'string' || !BUILTIN_MCP_CONNECTOR_IDS.includes(server.id)) return server;
    let id = `${server.id}-custom`;
    for (let n = 2; taken.has(id); n++) id = `${server.id}-custom-${n}`;
    taken.add(id);
    changed = true;
    return { ...server, id };
  });
  return changed;
}

/**
 * The settings file's connector settings with old names renamed, in place (and custom servers
 * moved off built-in ids); whether anything changed (the caller may save it)
 */
export function migrateMcpConnectorSettings(settings: Record<string, unknown> | undefined): boolean {
  const connectors = settings?.mcpConnectors;
  if (!connectors || typeof connectors !== 'object') return false;
  const record = connectors as Record<string, unknown>;
  const renamed = [
    renameField(record, 'puppeteerEnabled', 'playwrightEnabled'),
    renameField(record, 'puppeteerBrowser', 'playwrightBrowser'),
  ].some(Boolean);
  const moved = moveCustomServersOffBuiltinIds(record);
  const browser = record.playwrightBrowser as PlaywrightBrowserChoice | undefined;
  const migrated = migrateBrowserChoice(browser);
  if (migrated !== browser) record.playwrightBrowser = migrated;
  return renamed || moved || migrated !== browser;
}

/**
 * A task's (or task draft's) connector fields with old names renamed, in place: its connector ids
 * (not ones the custom servers have now, `customServerIds`) and its browser pick. Whether anything changed
 */
export function migrateTaskConnectorFields(
  metadata: Record<string, unknown> | undefined | null,
  customServerIds: Iterable<string> = []
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  let changed = renameField(metadata, 'puppeteerBrowser', 'playwrightBrowser');
  if (Array.isArray(metadata.mcpConnectors)) {
    const ids = metadata.mcpConnectors as string[];
    const normalized = normalizeMcpConnectorIds(ids, customServerIds);
    if (normalized.length !== ids.length || normalized.some((id, index) => id !== ids[index])) {
      metadata.mcpConnectors = normalized;
      changed = true;
    }
  }
  const browser = metadata.playwrightBrowser as PlaywrightBrowserChoice | null | undefined;
  const migrated = migrateBrowserChoice(browser);
  if (migrated !== browser) {
    metadata.playwrightBrowser = migrated;
    changed = true;
  }
  return changed;
}
