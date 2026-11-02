/**
 * MCP connectors for Claude Code runs
 * ===================================
 *
 * Turns a task's connector ids (Settings > Connectors defaults, or the task's own choice) into
 * the JSON accepted by `claude --mcp-config`. The servers are added on top of whatever the
 * user's own Claude Code configuration (.mcp.json, ~/.claude.json, plugins) already loads.
 *
 * When Claude Code runs in WSL it starts the servers inside the distribution: Windows paths in a
 * custom server's command and arguments are translated, and the built-in servers need npx there.
 *
 * Puppeteer: the MCP project's server (@modelcontextprotocol/server-puppeteer, archived but
 * working) stays. It reads PUPPETEER_LAUNCH_OPTIONS, so a browser profile chosen in Settings >
 * Connectors becomes its executable, its engine (Chromium or Firefox) and, for runs, a copy of the
 * profile (browser-profiles/profile-copy.ts: Chrome 136+ refuses remote debugging on its default
 * user data folder, and an open browser locks it). chrome-devtools-mcp was weighed and left for
 * later: it supports Chrome only (no Firefox), its --autoConnect needs Chrome 144+ with remote
 * debugging switched on by hand and drives the user's live browser from runs without permission
 * checks, and its tools differ from the ones the availability check calls.
 */

import type { CustomMcpServer } from '../../shared/types/project';
import type { McpConnectorSettings } from '../../shared/types/settings';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import { getDefaultMcpConnectorIds, getUsableCustomServers } from '../../shared/utils/mcp-connectors';
import { appLog } from '../app-logger';
import { getWslInfo, toRuntimePath } from '../platform/shell-runtime';
import { isWindows } from '../platform';
import { toRuntimeArg } from '../platform/runtime-exec';
import { SNAP_UNCONFINED_BINARIES } from '../browser-profiles/locations';

export type McpServerEntry =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface ClaudeMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * electron-mcp-server's executable has no `#!/usr/bin/env node` line, so on Linux and macOS (and
 * in WSL) the shell runs it as a script and it fails at once; there npx runs it with node.
 * Windows starts it through npm's .cmd shim, which already uses node
 */
function electronServer(): McpServerEntry {
  const posix = !isWindows() || !!getWslInfo();
  return posix
    ? { type: 'stdio', command: 'npx', args: ['-y', '-p', 'electron-mcp-server', '-c', 'node "$(command -v electron-mcp-server)"'] }
    : { type: 'stdio', command: 'npx', args: ['-y', 'electron-mcp-server'] };
}

/** Options for one run's servers */
export interface McpRunOptions {
  /** A copy of the chosen browser profile for this run (host path; see profile-copy.ts) */
  browserProfileDir?: string;
}

/**
 * Snap launchers Puppeteer can't drive: `/snap/bin/firefox` starts Firefox in the snap's sandbox,
 * which can't open Puppeteer's profile in /tmp, so the launch times out. The snap's own binary
 * runs outside the sandbox and works (detect.ts also maps Ubuntu's `/usr/bin/firefox` script, which
 * starts the snap, to the launcher, and checks that the binary runs on this system). Snap Chromium
 * keeps its launcher; its profile copy lives where the snap may write (profile-copy.ts)
 */
const SNAP_BINARIES = SNAP_UNCONFINED_BINARIES;

/**
 * Firefox prefs for every launch: a profile copy keeps its Firefox Account sign-in, and Sync would
 * then upload what the agent browses to the user's other devices. Sync starts only with both
 * set (services-sync/Weave.sys.mjs `enabled`)
 */
export const FIREFOX_NO_SYNC_PREFS: Record<string, unknown> = {
  'identity.fxaccounts.enabled': false,
  'services.sync.username': '',
};

/**
 * Puppeteer's launch options for the chosen browser: its executable and engine, and with a
 * profile copy its folder. Chromium's default `--password-store=basic` / `--use-mock-keychain`
 * would keep it from decrypting the copied sign-ins, so they are left out
 */
export function puppeteerLaunchOptions(choice: PuppeteerBrowserChoice, browserProfileDir?: string): Record<string, unknown> {
  const executablePath = SNAP_BINARIES[choice.executablePath] ?? choice.executablePath;
  const launch: Record<string, unknown> = { executablePath };
  if (choice.engine === 'firefox') {
    launch.browser = 'firefox';
    launch.extraPrefsFirefox = FIREFOX_NO_SYNC_PREFS;
  }
  if (browserProfileDir) {
    launch.userDataDir = toRuntimePath(browserProfileDir);
    if (choice.engine === 'chromium') {
      launch.args = [`--profile-directory=${choice.profileDirectory ?? 'Default'}`];
      launch.ignoreDefaultArgs = ['--password-store=basic', '--use-mock-keychain'];
    }
  }
  return launch;
}

/**
 * The MCP project's Puppeteer server: Puppeteer's own Chrome (downloaded the first time), or the
 * browser chosen in Settings > Connectors
 */
function puppeteerServer(choice: PuppeteerBrowserChoice | undefined, options: McpRunOptions): McpServerEntry {
  const entry: McpServerEntry = { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] };
  if (!choice) return entry;
  return { ...entry, env: { PUPPETEER_LAUNCH_OPTIONS: JSON.stringify(puppeteerLaunchOptions(choice, options.browserProfileDir)) } };
}

/** Built-in connectors (Settings > Connectors) */
function builtinServer(id: string, settings: McpConnectorSettings | undefined, options: McpRunOptions = {}): McpServerEntry | undefined {
  switch (id) {
    case 'context7':
      return { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
    case 'electron':
      return electronServer();
    case 'puppeteer':
      return puppeteerServer(settings?.puppeteerBrowser, options);
    default:
      return undefined;
  }
}

function customServerEntry(server: CustomMcpServer): McpServerEntry | null {
  if (server.type === 'command') {
    if (!server.command) return null;
    // In WSL, whole-argument Windows paths become the distribution's paths (as for every tool launch)
    const translate = getWslInfo() ? toRuntimeArg : (arg: string) => arg;
    return { type: 'stdio', command: translate(server.command), args: (server.args ?? []).map(translate) };
  }
  return server.url ? { type: 'http', url: server.url, headers: server.headers } : null;
}

/**
 * How long Claude Code waits for MCP servers to start (MCP_TIMEOUT). Its 30 second default is too
 * short for a server's first start, when npx downloads it (Puppeteer also downloads Chromium);
 * later starts come from npx's cache
 */
export const MCP_STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

/** MCP server key accepted by Claude Code (letters, digits, `_` and `-`) */
function serverKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

let warnedNoNpx = false;

/** The built-in servers run with npx; in WSL that has to be the distribution's npx */
function warnWhenNpxMissingInWsl(): void {
  const wsl = getWslInfo();
  if (!wsl || wsl.tools.npx.path || warnedNoNpx) return;
  warnedNoNpx = true;
  appLog.warn(
    `[MCP] npx isn't installed in WSL (${wsl.distro}), so the built-in connectors (Context7, Electron, Puppeteer) ` +
    "can't start in Claude Code runs there. Install Node.js inside WSL to use them"
  );
}

/**
 * One connector's server entry, as a Claude Code run would start it (null when it can't be);
 * without a run's browser profile copy, so a check never touches a profile
 */
export function mcpServerEntry(id: string, connectorSettings: McpConnectorSettings | undefined): McpServerEntry | null {
  const builtin = builtinServer(id, connectorSettings);
  if (builtin) return builtin;
  const server = getUsableCustomServers(connectorSettings).find((s) => s.id === id);
  return server ? customServerEntry(server) : null;
}

/**
 * Build the `--mcp-config` object for the given connector ids.
 * `ids` undefined means "use the Connectors defaults".
 */
export function buildMcpConfig(
  ids: string[] | undefined,
  connectorSettings: McpConnectorSettings | undefined,
  options: McpRunOptions = {}
): ClaudeMcpConfig {
  const enabled = ids ?? getDefaultMcpConnectorIds(connectorSettings);
  const custom = getUsableCustomServers(connectorSettings);
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const id of enabled) {
    const builtin = builtinServer(id, connectorSettings, options);
    if (builtin) {
      warnWhenNpxMissingInWsl();
      mcpServers[id] = builtin;
      continue;
    }
    const server = custom.find((s) => s.id === id);
    const entry = server ? customServerEntry(server) : null;
    if (entry) mcpServers[serverKey(server!.name || id)] = entry;
  }
  return { mcpServers };
}
