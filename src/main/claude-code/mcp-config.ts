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
 * Playwright: Microsoft's own server (@playwright/mcp, pinned: PLAYWRIGHT_MCP_PACKAGE). Its tools
 * act on the page's accessibility snapshot and wait for elements by themselves, and it drives
 * Chromium, Firefox and WebKit. A browser profile chosen in Settings >
 * Connectors becomes, for runs, a copy of the profile (browser-profiles/profile-copy.ts: Chrome
 * 136+ refuses remote debugging on its default user data folder, and an open browser locks it)
 * launched with the browser's own executable through a config file in the copy
 * (playwrightProfileConfig). The user's Firefox is driven over WebDriver BiDi (Playwright's
 * `moz-firefox` channel, which it still calls experimental): Playwright's `firefox` alone means
 * its own patched build, which can't drive a stock Firefox. Without a profile (Playwright's own
 * browsers, the availability check) the server gets command line options and a profile in
 * memory (`--isolated`). Every run's browser is headless (`--headless`): no window opens, and the
 * user watches and drives it in Workbench's browser drawer (browser-drawer/), which also sizes the
 * viewed page to the drawer. chrome-devtools-mcp was weighed and left out: it supports Chrome only (no Firefox), its
 * --autoConnect needs Chrome 144+ with remote debugging switched on by hand and drives the user's
 * live browser from runs without permission checks.
 */

import os from 'os';
import path from 'path';
import type { CustomMcpServer } from '../../shared/types/project';
import type { McpConnectorSettings } from '../../shared/types/settings';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { getDefaultMcpConnectorIds, getUsableCustomServers } from '../../shared/utils/mcp-connectors';
import { appLog } from '../app-logger';
import { getWslInfo, toRuntimePath } from '../platform/shell-runtime';
import { isWindows } from '../platform';
import { toRuntimeArg } from '../platform/runtime-exec';
import { SNAP_UNCONFINED_BINARIES } from '../browser-profiles/locations';
import { appAliasTarget } from '../browser-profiles/app-alias';
import { PLAYWRIGHT_MCP_PACKAGE, isPlaywrightBuild } from '../browser-profiles/managed';
import { isWindowsBrowserInWsl, windowsBrowserScripts } from '../browser-profiles/windows-browser';

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
 * Snap launchers Playwright can't drive: `/snap/bin/firefox` starts Firefox in the snap's sandbox,
 * which can't open a profile copy outside the snap's folders, so the launch times out. The snap's
 * own binary runs outside the sandbox and works (detect.ts also maps Ubuntu's `/usr/bin/firefox`
 * script, which starts the snap, to the launcher, and checks that the binary runs on this system).
 * Snap Chromium keeps its launcher; its profile copy lives where the snap may write (profile-copy.ts)
 */
const SNAP_BINARIES = SNAP_UNCONFINED_BINARIES;

/**
 * Firefox prefs for every launch with a profile copy: the copy keeps its Firefox Account sign-in,
 * and Sync would then upload what the agent browses to the user's other devices. Sync starts only
 * with both set (services-sync/Weave.sys.mjs `enabled`). Playwright writes them to the copy's user.js
 */
export const FIREFOX_NO_SYNC_PREFS: Record<string, unknown> = {
  'identity.fxaccounts.enabled': false,
  'services.sync.username': '',
};

/**
 * Playwright's default Chromium switches that keep a copy from decrypting its sign-ins: a basic
 * password store (Linux) and a mock keychain (macOS) instead of the ones the profile was saved with
 */
const CHROMIUM_KEYCHAIN_ARGS = ['--password-store=basic', '--use-mock-keychain'];
/** Playwright's switch that keeps Chromium from running the profile's extensions */
const CHROMIUM_NO_EXTENSIONS_ARG = '--disable-extensions';
/**
 * Lets a CDP client over the browser's pipe click an extension's toolbar button
 * (`Extensions.triggerAction`): the browser drawer opens extensions' popups with it
 */
const CHROMIUM_EXTENSION_DEBUGGING_ARG = '--enable-unsafe-extension-debugging';

export interface PlaywrightProfileOptions {
  /** The browser runs the extensions in the copy (Settings > Browser, chat browsers only) */
  extensions?: boolean;
}

/** The run's Playwright config inside its profile copy (written by profile-copy.ts) */
export const PLAYWRIGHT_CONFIG_FILE = '.workbench-playwright.json';

/**
 * The browsers' pixel density: the screens' largest devicePixelRatio (display-scale.ts), so the
 * drawer can show their pages as sharp as the rest of the window. 1 adds nothing. Chromium needs its
 * own switch too: a context's deviceScaleFactor alone leaves its screencast frames at CSS size
 * (chromiumScaleSwitch)
 */
let playwrightScale: { scale: number; configFiles: Record<'chromium' | 'other', string> } | null = null;

/** The screens' density (null or 1: none); `configFiles` hold playwrightScaleConfig for runs without a profile copy */
export function setPlaywrightDisplayScale(value: typeof playwrightScale): void {
  playwrightScale = value && value.scale > 1 ? value : null;
}

/**
 * Chromium's switch for frames at device pixels, rounded up to a whole factor: with a fractional
 * one (1.25, 1.5) the screencast sends no frames once the drawer sets the page's viewport, so the
 * drawer stays blank. Pages still render at the context's deviceScaleFactor (the real `scale`),
 * and the frames come at the size the drawer asks for
 */
export function chromiumScaleSwitch(scale: number): string {
  return `--force-device-scale-factor=${Math.ceil(scale)}`;
}

/** The Playwright config that renders pages at `scale` device pixels per CSS pixel */
export function playwrightScaleConfig(engine: 'chromium' | 'other', scale: number): { browser: Record<string, unknown> } {
  return {
    browser: {
      contextOptions: { deviceScaleFactor: scale },
      ...(engine === 'chromium' ? { launchOptions: { args: [chromiumScaleSwitch(scale)] } } : {}),
    },
  };
}

/** The server key of the Playwright connector in `--mcp-config` */
const PLAYWRIGHT_SERVER_KEY = 'playwright';

/**
 * A chosen browser's executable where runs start it: snap launchers -> the snap's own binary, a
 * Microsoft Store app's execution alias -> the package's executable it points at
 */
function launchExecutable(choice: PlaywrightBrowserChoice): string {
  return SNAP_BINARIES[choice.executablePath] ?? appAliasTarget(choice.executablePath);
}

/**
 * A Windows Firefox profile run by a Firefox in WSL (detect.ts): the copy goes into the
 * distribution, and the Firefox there may be older than the one that wrote the profile
 */
function isWindowsProfileInWsl(choice: PlaywrightBrowserChoice): boolean {
  return getWslInfo() !== null && /^[A-Za-z]:[\\/]/.test(choice.profilePath);
}

/**
 * Firefox refuses a profile a newer version wrote ("Please create a new profile"); a run's copy
 * may be opened anyway, since only the copy can be harmed
 */
const FIREFOX_ALLOW_DOWNGRADE = '--allow-downgrade';

/**
 * The Playwright config of a run with a copy of the chosen profile (`browserProfileDir`, a host
 * path): the browser's executable with the copy as its profile. Chromium opens the profile's
 * folder inside the copied user data folder, with the sandbox on (Playwright's default off is for
 * its own build) and without Playwright's switches that keep it from decrypting the copied
 * sign-ins. Firefox runs over WebDriver BiDi (the `moz-firefox` channel; Playwright's own build,
 * which runs Windows profiles in WSL, over its own protocol) with Sync kept off. Firefox runs the
 * extensions the copy holds; Chromium only with `extensions` (Playwright switches them off)
 */
export function playwrightProfileConfig(
  choice: PlaywrightBrowserChoice,
  browserProfileDir: string,
  options: PlaywrightProfileOptions = {}
): Record<string, unknown> {
  const userDataDir = toRuntimePath(browserProfileDir);
  const executablePath = launchExecutable(choice);
  const scale = playwrightScale?.scale;
  const contextOptions = scale ? { contextOptions: { deviceScaleFactor: scale } } : {};
  if (choice.engine === 'firefox') {
    return {
      browser: {
        browserName: 'firefox',
        userDataDir,
        launchOptions: {
          ...(isPlaywrightBuild(executablePath) ? {} : { channel: 'moz-firefox' }),
          executablePath,
          ...(isWindowsProfileInWsl(choice) ? { args: [FIREFOX_ALLOW_DOWNGRADE] } : {}),
          firefoxUserPrefs: FIREFOX_NO_SYNC_PREFS,
        },
        ...contextOptions,
      },
    };
  }
  return {
    browser: {
      browserName: 'chromium',
      userDataDir,
      launchOptions: {
        executablePath,
        chromiumSandbox: true,
        args: [
          `--profile-directory=${choice.profileDirectory ?? 'Default'}`,
          ...(scale ? [chromiumScaleSwitch(scale)] : []),
          ...(options.extensions ? [CHROMIUM_EXTENSION_DEBUGGING_ARG] : []),
        ],
        ignoreDefaultArgs: options.extensions ? [...CHROMIUM_KEYCHAIN_ARGS, CHROMIUM_NO_EXTENSIONS_ARG] : CHROMIUM_KEYCHAIN_ARGS,
      },
      ...contextOptions,
    },
  };
}

/** Playwright's `--browser` for its own builds (`chromium` is Chrome for Testing, never the installed Chrome) */
const MANAGED_BROWSER_OPTION: Record<PlaywrightBrowserChoice['engine'], string> = {
  chromium: 'chromium',
  firefox: 'firefox',
  webkit: 'webkit',
};

/**
 * Runs never open a browser window: the browser runs headless and the user sees and drives it in
 * Workbench's browser drawer (browser-drawer/). On the command line, so it also applies over
 * a profile copy's config file
 */
const PLAYWRIGHT_HEADLESS_OPTION = '--headless';

/**
 * The server's options for the chosen browser. With a run's profile copy: the config file in it.
 * Otherwise a profile in memory (`--isolated`): Playwright's own build of the browser (its
 * Chromium when nothing is chosen, with the sandbox on), or the chosen browser's executable (`chrome` / `moz-firefox`
 * only pick the engine and keep Chromium's sandbox on; the executable is the chosen one)
 */
export function playwrightServerArgs(choice: PlaywrightBrowserChoice | undefined, browserProfileDir?: string): string[] {
  return [...playwrightBrowserArgs(choice, browserProfileDir), PLAYWRIGHT_HEADLESS_OPTION];
}

function playwrightBrowserArgs(choice: PlaywrightBrowserChoice | undefined, browserProfileDir?: string): string[] {
  if (choice && !choice.managed && browserProfileDir) {
    return ['--config', toRuntimePath(joinHostPath(browserProfileDir, PLAYWRIGHT_CONFIG_FILE))];
  }
  const engine = choice?.engine ?? 'chromium';
  // The screens' density (a config file the command line adds to)
  const scaleConfig = playwrightScale
    ? ['--config', toRuntimePath(playwrightScale.configFiles[engine === 'chromium' ? 'chromium' : 'other'])]
    : [];
  if (!choice || choice.managed) {
    // Playwright leaves its own Chromium's sandbox off on Linux (and so in WSL): pages would run unsandboxed
    return [...scaleConfig, '--browser', MANAGED_BROWSER_OPTION[engine], '--isolated', ...(engine === 'chromium' ? ['--sandbox'] : [])];
  }
  // Playwright's own Firefox build speaks its own protocol, not BiDi (`moz-firefox`)
  const firefox = isPlaywrightBuild(choice.executablePath) ? 'firefox' : 'moz-firefox';
  const browser = choice.engine === 'firefox' ? firefox : 'chrome';
  return [...scaleConfig, '--browser', browser, '--executable-path', launchExecutable(choice), '--isolated'];
}

/** A file inside a host folder (a Windows, UNC or POSIX path) */
function joinHostPath(dir: string, name: string): string {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(dir) ? path.win32.join(dir, name) : path.posix.join(dir, name);
}

/**
 * Microsoft's Playwright server: Playwright's own Chromium (downloaded with its install-browser
 * command), or the browser chosen in Settings > Browser or the task
 */
function playwrightServer(choice: PlaywrightBrowserChoice | undefined, options: McpRunOptions): McpServerEntry {
  if (choice && isWindowsBrowserInWsl(choice)) return windowsBrowserServer(choice, options.browserProfileDir);
  return { type: 'stdio', command: 'npx', args: ['-y', PLAYWRIGHT_MCP_PACKAGE, ...playwrightServerArgs(choice, options.browserProfileDir)] };
}

/**
 * A Windows Chromium browser while tools run in WSL (browser-profiles/windows-browser.ts): the
 * distribution's node runs the launcher, which starts the browser on the run's profile copy (or a
 * new profile in the Windows temp folder) and then the server attached to it over CDP. Windows
 * paths for the Windows processes, runtime paths for the launcher
 */
function windowsBrowserServer(choice: PlaywrightBrowserChoice, browserProfileDir: string | undefined): McpServerEntry {
  const scripts = windowsBrowserScripts();
  const launch = {
    executable: toRuntimePath(choice.executablePath),
    // No --force-device-scale-factor (other runs' HiDPI switch): with it, the viewport the drawer
    // sets over CDP leaves Playwright's screencast without frames, so the drawer stays blank
    args: [`--profile-directory=${choice.profileDirectory ?? 'Default'}`],
    ...(browserProfileDir ? { userDataDir: { windows: browserProfileDir, runtime: toRuntimePath(browserProfileDir) } } : {}),
    tempDir: { windows: os.tmpdir(), runtime: toRuntimePath(os.tmpdir()) },
    relay: { command: toRuntimePath(process.execPath), script: scripts.relay },
  };
  return {
    type: 'stdio',
    command: 'node',
    args: [toRuntimePath(scripts.launcher), JSON.stringify(launch), 'npx', '-y', PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_HEADLESS_OPTION],
  };
}

/**
 * The servers with Playwright's files (screenshots and snapshots saved without a name) going to
 * `dir`, a host folder the run removes when it ends: by default they would land in the session's
 * working folder (`.playwright-mcp` in the task's worktree or the project)
 */
export function withPlaywrightOutputDir(servers: Record<string, McpServerEntry>, dir: string | undefined): Record<string, McpServerEntry> {
  const entry = servers[PLAYWRIGHT_SERVER_KEY];
  if (!dir || entry?.type !== 'stdio' || !entry.args?.includes(PLAYWRIGHT_MCP_PACKAGE)) return servers;
  return { ...servers, [PLAYWRIGHT_SERVER_KEY]: { ...entry, args: [...entry.args, '--output-dir', toRuntimePath(dir)] } };
}

/** Built-in connectors (Settings > Connectors) */
function builtinServer(id: string, settings: McpConnectorSettings | undefined, options: McpRunOptions = {}): McpServerEntry | undefined {
  switch (id) {
    case 'context7':
      return { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
    case 'electron':
      return electronServer();
    case PLAYWRIGHT_SERVER_KEY:
      return playwrightServer(settings?.playwrightBrowser, options);
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
 * short for a server's first start, when npx downloads it;
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
    `[MCP] npx isn't installed in WSL (${wsl.distro}), so the built-in connectors (Context7, Electron, Playwright) ` +
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
