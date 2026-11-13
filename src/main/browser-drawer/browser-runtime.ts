/**
 * Where chat browsers run on Windows
 * ==================================
 *
 * With the WSL shell (Settings > General), everything Workbench starts runs inside the
 * distribution, chat browsers too: the holder's server (wsl.exe, npx there), its profile copy
 * (written through `\\wsl.localhost`, slow for a profile's many files), a Windows Chromium
 * through the launcher and the DevTools relay (windows-browser.ts), the drawer's bridge and the
 * registry read through `\\wsl.localhost`. Settings > Browser > Browser runtime
 * (`AppSettings.browser.windowsRuntime`) can run chat browsers on Windows instead, as with the
 * PowerShell shell: their profiles copied on Windows, launched by Playwright itself, the bridge
 * and the registry native, while Claude Code and task runs stay in WSL. A chat turn's Playwright
 * then runs on Windows too, through interop (claude-code-runner.ts's guard): it attaches to the
 * chat's browser through Windows' registry, which the distribution can't reach.
 *
 * That needs Node.js (npx starts Playwright's MCP server) on Windows, and, for Playwright's own
 * browser as the default profile, its build in Windows' Playwright cache: the settings row's
 * Autoconfigure button installs what is missing in a PowerShell window. Decided once at startup
 * (like the shell): `windowsRuntime: 'pwsh'` with something missing keeps chat browsers in WSL.
 * Their code runs inside runNatively() (shell-runtime.ts), so the native paths apply throughout.
 */

import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { app } from 'electron';
import type { AppSettings, ChatBrowserRuntimeStatus, WindowsBrowserRequirement, WindowsShell } from '../../shared/types/settings';
import type { BrowserProfile, DownloadableBrowser, PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { toBrowserChoice } from '../../shared/utils/browser-choice';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { getWindowsShellPaths } from '../platform/paths';
import { getSessionWslInfo, runNatively, whenShellRuntimeReady } from '../platform/shell-runtime';
import { runTool } from '../platform/runtime-exec';
import type { WslProbeResult } from '../platform/wsl-detect';
import { readSettingsFileAsync } from '../settings-utils';
import { findWindowsExecutableViaWhereAsync } from '../utils/windows-paths';
import { getNodeVersionManagerPaths } from '../cli-tool-manager';
import { detectWindowsBrowserProfiles } from '../browser-profiles/detect';
import { findManagedBrowser, PLAYWRIGHT_MCP_PACKAGE, playwrightInstallCommand } from '../browser-profiles/managed';

/** The oldest Node.js Playwright's MCP server runs on (playwright-core's engines) */
const NODE_MIN_MAJOR = 20;
/** How long `node --version` may take */
const VERSION_TIMEOUT_MS = 10_000;

/** Node.js on Windows: node and the npx beside it */
export interface WindowsNode {
  node: string;
  npx: string;
  version: string;
}

/** `v22.11.0` -> 22 (0 when unreadable) */
export function nodeMajor(version: string): number {
  const major = Number.parseInt(version.trim().replace(/^v/i, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

/** npx next to a node (npm's npx.cmd; Volta's npx.exe shim) */
function npxBeside(node: string): string | null {
  const dir = path.win32.dirname(node);
  for (const name of ['npx.cmd', 'npx.exe']) {
    const npx = path.win32.join(dir, name);
    if (existsSync(npx)) return npx;
  }
  return null;
}

/**
 * Where node.exe may be: Settings > Developer's path, the PATH this app started with, Node.js's
 * installer folder (an install made since isn't on that PATH yet) and version managers' folders
 */
async function nodeCandidates(settingsPath: string | undefined): Promise<string[]> {
  const onPath = await findWindowsExecutableViaWhereAsync('node', '[BrowserDrawer]');
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((dir): dir is string => !!dir);
  return [
    ...(settingsPath && /^[A-Za-z]:[\\/]/.test(settingsPath) ? [settingsPath] : []),
    ...(onPath ? [onPath] : []),
    ...programFiles.map((dir) => path.win32.join(dir, 'nodejs', 'node.exe')),
    ...getNodeVersionManagerPaths(os.homedir(), () => []),
  ];
}

/** Node.js on Windows, at least NODE_MIN_MAJOR with npx beside it, or null */
async function findWindowsNode(settingsPath: string | undefined): Promise<WindowsNode | null> {
  for (const node of new Set(await nodeCandidates(settingsPath))) {
    if (!existsSync(node)) continue;
    const npx = npxBeside(node);
    if (!npx) continue;
    // Natively, also in a WSL session
    const version = await runNatively(() => runTool('node', ['--version'], { command: node, timeout: VERSION_TIMEOUT_MS }))
      .then((result) => result.stdout.trim(), () => '');
    if (version && nodeMajor(version) >= NODE_MIN_MAJOR) return { node, npx, version };
  }
  return null;
}

/** Playwright's own build a profile choice needs (none for a user's browser profile) */
export function managedBuildOf(choice: PlaywrightBrowserChoice | undefined): DownloadableBrowser | null {
  if (!choice) return 'chromium';
  if (!choice.managed) return null;
  return choice.engine === 'webkit' ? 'webkit' : choice.engine === 'firefox' ? 'firefox' : 'chromium';
}

const windowsContext = () => ({ os: 'windows' as const, home: os.homedir(), env: process.env, toHost: (p: string) => p });

/** A choice from WSL's list that only WSL has: neither a Windows profile (`windows-<id>`) nor one of Playwright's */
function isWslOnlyChoice(choice: PlaywrightBrowserChoice | undefined): boolean {
  return !!choice && !choice.managed && !choice.id.startsWith('windows-');
}

interface Requirements {
  missing: WindowsBrowserRequirement[];
  node: WindowsNode | null;
}

/** What running chat browsers on Windows needs that is missing (Windows with the WSL shell) */
async function checkRequirements(): Promise<Requirements> {
  const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
  const node = await findWindowsNode(settings?.nodePath);
  const choice = settings?.mcpConnectors?.playwrightBrowser;
  const build = managedBuildOf(choice);
  const missing: WindowsBrowserRequirement[] = [];
  if (!node) missing.push('node');
  if (build && !(await findManagedBrowser(build, windowsContext()))) missing.push('browserBuild');
  // The default profile is a browser only the distribution has
  if (isWslOnlyChoice(choice)) missing.push('profile');
  // A chat turn (Claude Code in WSL) starts its Windows side through interop
  if (getSessionWslInfo()?.interop === false) missing.push('interop');
  return { missing, node };
}

interface RuntimeState {
  /** Chat browsers run on Windows while the shell is WSL (decided at startup) */
  native: boolean;
  /** Windows' Node.js as found when that was decided (fixed for the session) */
  node: WindowsNode | null;
  /** The latest check (the settings row's status) */
  requirements: Requirements | null;
  configuring: boolean;
}

let state: RuntimeState = { native: false, node: null, requirements: null, configuring: false };
let ready: Promise<void> | null = null;
/** Told when the status changes (an autoconfigure finished): every window gets it */
let notify: ((status: ChatBrowserRuntimeStatus) => void) | null = null;

/** Where the shell's chat browsers run unless the setting says otherwise */
function configuredRuntime(settings: Partial<AppSettings> | undefined): WindowsShell {
  return settings?.browser?.windowsRuntime ?? (getSessionWslInfo() ? 'wsl' : 'pwsh');
}

/**
 * Where this session's chat browsers run, decided once (the first call; startup makes it): on
 * Windows only with the WSL shell, the setting at 'pwsh' and nothing missing. Windows is only
 * looked at for that; otherwise the settings row asks when it shows
 */
export function whenChatBrowserRuntimeReady(): Promise<void> {
  ready ??= (async () => {
    await whenShellRuntimeReady();
    if (!isWindows() || !getSessionWslInfo()) return;
    const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
    if (configuredRuntime(settings) !== 'pwsh') return;
    const requirements = await checkRequirements();
    const native = requirements.missing.length === 0;
    state = { ...state, native, node: native ? requirements.node : null, requirements };
    if (!native) appLog.warn(`[BrowserDrawer] Chat browsers run in WSL: running them on Windows needs ${requirements.missing.join(', ')}`);
  })().catch((error: unknown) => {
    appLog.warn('[BrowserDrawer] Could not decide where chat browsers run:', error);
  });
  return ready;
}

/** Whether this session's chat browsers run on Windows while the shell is WSL (after the startup decision) */
export function chatBrowsersOnWindows(): boolean {
  return state.native;
}

/** The distribution chat browsers run in, or null when they run natively (always so off WSL) */
export function chatBrowserWsl(): WslProbeResult | null {
  return state.native ? null : getSessionWslInfo();
}

/** Run chat browser code where chat browsers run: natively (runNatively) when they run on Windows */
export function inChatBrowserRuntime<T>(fn: () => T): T {
  return state.native ? runNatively(fn) : fn();
}

/** Windows' Node.js while chat browsers run on Windows (as found at the startup decision), else null */
export function windowsNode(): WindowsNode | null {
  return state.native ? state.node : null;
}

/** `env` with Windows' node first on its PATH (npx's shims start `node` from the PATH) */
export function withWindowsNodeOnPath(env: NodeJS.ProcessEnv, node: WindowsNode): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  const key = Object.keys(result).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  result[key] = [path.win32.dirname(node.node), result[key]].filter(Boolean).join(';');
  return result;
}

/** Thrown for a Playwright build that isn't downloaded on Windows: the command that downloads it */
function notDownloaded(name: string, build: DownloadableBrowser): Error {
  return new Error(
    `${name} isn't downloaded on Windows, where chat browsers run (Settings > Browser > Browser runtime). `
    + `Download it in PowerShell: ${playwrightInstallCommand(build)}`
  );
}

/**
 * A chat's browser choice as it runs on Windows. Choices are made from WSL's list in WSL mode:
 * a Windows profile there is `windows-<id>`, the same profile natively `<id>`; Playwright's own
 * browsers have the same ids in both. undefined is Playwright's own Chromium. Thrown, with what to
 * do: a Playwright build not downloaded on Windows, a browser only WSL has
 */
export async function windowsBrowserChoice(choice: PlaywrightBrowserChoice | undefined): Promise<PlaywrightBrowserChoice | undefined> {
  if (!choice) {
    if (!(await findManagedBrowser('chromium', windowsContext()))) throw notDownloaded("Playwright's Chromium", 'chromium');
    return undefined;
  }
  const id = choice.id.startsWith('windows-') ? choice.id.slice('windows-'.length) : choice.id;
  const find = (profiles: BrowserProfile[]) => profiles.find((profile) => profile.id === id);
  let profile = find(await detectWindowsBrowserProfiles());
  // Downloaded or added since the list was read
  if (!profile?.usable) profile = find(await detectWindowsBrowserProfiles({ refresh: true }));
  const native = profile && toBrowserChoice(profile);
  if (native) return native;
  const build = managedBuildOf(choice);
  if (build) throw notDownloaded(`Playwright's ${choice.browser}`, build);
  throw new Error(
    `${choice.profileName} (${choice.browser}) can't run on Windows, where chat browsers run (Settings > Browser > Browser runtime). Pick a Windows browser profile for the chat`
  );
}

/** The settings row's status (Windows): what running chat browsers there needs, checked when asked */
export async function getChatBrowserRuntimeStatus(options: { refresh?: boolean } = {}): Promise<ChatBrowserRuntimeStatus> {
  await whenChatBrowserRuntimeReady();
  const wslShell = isWindows() && !!getSessionWslInfo();
  if (wslShell && (options.refresh || !state.requirements)) state = { ...state, requirements: await checkRequirements() };
  return {
    active: state.native || !wslShell ? 'pwsh' : 'wsl',
    wslShell,
    missing: wslShell ? state.requirements?.missing ?? [] : [],
    ...(state.configuring ? { configuring: true } : {}),
  };
}

/** Where every window is told of a new status (set by the IPC handlers) */
export function onChatBrowserRuntimeStatus(listener: (status: ChatBrowserRuntimeStatus) => void): void {
  notify = listener;
}

/** A PowerShell string literal */
function psString(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The autoconfigure script: Node.js LTS through winget unless a new enough one is installed, then
 * Playwright's MCP server into npx's cache (its first start then downloads nothing), with
 * Playwright's build of the default browser when it needs one
 */
export function autoconfigureScript(build: DownloadableBrowser | null): string {
  const pkg = psString(PLAYWRIGHT_MCP_PACKAGE);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$Host.UI.RawUI.WindowTitle = 'Workbench: chat browsers on Windows'",
    'function Update-PathFromRegistry {',
    "  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
    '}',
    'try {',
    '  Update-PathFromRegistry',
    '  $major = 0',
    '  if (Get-Command node -ErrorAction SilentlyContinue) {',
    "    $major = [int]((& node --version).TrimStart('v').Split('.')[0])",
    '  }',
    `  if ($major -lt ${NODE_MIN_MAJOR}) {`,
    '    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {',
    `      throw 'winget is not available. Install Node.js ${NODE_MIN_MAJOR} or newer from https://nodejs.org, then press Autoconfigure again'`,
    '    }',
    "    Write-Host 'Installing Node.js (LTS) with winget...'",
    '    & winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements',
    '    if ($LASTEXITCODE -ne 0) { throw "winget could not install Node.js (exit code $LASTEXITCODE)" }',
    '    Update-PathFromRegistry',
    '  } else {',
    "    Write-Host ('Node.js ' + (& node --version) + ' is installed')",
    '  }',
    ...(build
      ? [
          `  Write-Host 'Installing Playwright''s ${build}...'`,
          `  & npx -y ${pkg} install-browser ${build}`,
          `  if ($LASTEXITCODE -ne 0) { throw "Playwright's ${build} could not be installed (exit code $LASTEXITCODE)" }`,
        ]
      : [
          "  Write-Host 'Fetching Playwright''s MCP server...'",
          `  & npx -y --package=${pkg} -- node -e 0`,
          '  if ($LASTEXITCODE -ne 0) { throw "Playwright\'s MCP server could not be fetched (exit code $LASTEXITCODE)" }',
        ]),
    "  Write-Host ''",
    "  Write-Host 'Done. Restart Workbench to run chat browsers on Windows.' -ForegroundColor Green",
    '} catch {',
    '  Write-Host $_ -ForegroundColor Red',
    '}',
    "Read-Host 'Press Enter to close'",
    '',
  ].join('\r\n');
}

/**
 * Autoconfigure (the settings row's button): a PowerShell window installs what running chat
 * browsers on Windows needs. The script is chosen here, never sent by the window. When it closes,
 * the requirements are checked again and every window gets the new status
 */
export async function autoconfigureChatBrowserRuntime(): Promise<ChatBrowserRuntimeStatus> {
  if (!isWindows()) throw new Error('Only on Windows');
  if (state.configuring) return getChatBrowserRuntimeStatus();
  const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
  const dir = path.join(app.getPath('userData'), 'windows-browser');
  const script = path.join(dir, 'autoconfigure.ps1');
  await mkdir(dir, { recursive: true });
  await writeFile(script, autoconfigureScript(managedBuildOf(settings?.mcpConnectors?.playwrightBrowser)), 'utf-8');
  // PowerShell 7 when installed, else Windows PowerShell (always there)
  const powershell = getWindowsShellPaths().powershell?.find((candidate) => existsSync(candidate)) ?? 'powershell.exe';
  // Its own console window, which the user watches and closes
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  state = { ...state, configuring: true };
  const finished = async () => {
    const requirements = await checkRequirements().catch(() => state.requirements);
    state = { ...state, configuring: false, requirements };
    notify?.(await getChatBrowserRuntimeStatus());
  };
  child.once('error', (error) => {
    appLog.warn('[BrowserDrawer] Could not open PowerShell to set up chat browsers on Windows:', error);
    void finished();
  });
  child.once('exit', () => void finished());
  child.unref();
  return getChatBrowserRuntimeStatus();
}

/** For tests: forget the startup decision */
export function resetChatBrowserRuntimeForTests(overrides: Partial<RuntimeState> = {}): void {
  state = { native: false, node: null, requirements: null, configuring: false, ...overrides };
  ready = overrides.native === undefined ? null : Promise.resolve();
}
