/**
 * Where chat browsers run on Windows
 * ==================================
 *
 * Always on Windows itself, whatever the shell (Settings > General): with the WSL shell their code
 * runs inside runNatively() (shell-runtime.ts), so the native paths apply throughout: the holder
 * started by Windows' Node.js (npx), its profile copied on Windows, launched by Playwright itself,
 * the drawer's bridge and the registry native, while Claude Code and task runs stay in WSL. A chat
 * turn's Playwright then runs on Windows too, through interop (claude-code-runner.ts's guard): it
 * attaches to the chat's browser through Windows' registry, which the distribution can't reach.
 *
 * Opening one needs Node.js on Windows and, for one of Playwright's own browsers, its build in
 * Windows' Playwright cache. While either is missing the browser drawer offers Autoconfigure in
 * place of Open browser, which installs them in a PowerShell window.
 */

import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types/settings';
import type { ChatBrowserRequirement, ChatBrowserRequirements } from '../../shared/types/browser-drawer';
import type { BrowserProfile, DownloadableBrowser, PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { toBrowserChoice } from '../../shared/utils/browser-choice';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { getWindowsShellPaths } from '../platform/paths';
import { getSessionWslInfo, runNatively, whenShellRuntimeReady } from '../platform/shell-runtime';
import { runTool } from '../platform/runtime-exec';
import { readSettingsFileAsync } from '../settings-utils';
import { findWindowsExecutableViaWhereAsync } from '../utils/windows-paths';
import { getNodeVersionManagerPaths } from '../cli-tool-manager';
import { detectWindowsBrowserProfiles } from '../browser-profiles/detect';
import { findManagedBrowser, PLAYWRIGHT_MCP_PACKAGE, playwrightInstallCommand } from '../browser-profiles/managed';
import { resolveCommand } from '../mcp-commands';

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

/** Whether chat browsers run on Windows while the shell is WSL (always so: never in the distribution) */
export function chatBrowsersOnWindows(): boolean {
  return isWindows() && !!getSessionWslInfo();
}

/** Ready once the shell runtime is (chat browsers follow it: natively on Windows) */
export async function whenChatBrowserRuntimeReady(): Promise<void> {
  await whenShellRuntimeReady();
}

/** Run chat browser code where chat browsers run: natively (runNatively) while the shell is WSL */
export function inChatBrowserRuntime<T>(fn: () => T): T {
  return chatBrowsersOnWindows() ? runNatively(fn) : fn();
}

/** Windows' Node.js last found (looked for again when it is gone or none was found) */
let foundNode: WindowsNode | null = null;

/**
 * Windows' Node.js while chat browsers run on Windows with the WSL shell (the shell's lookups are
 * the distribution's), else null; also null when none is installed (the drawer offers Autoconfigure)
 */
export async function chatBrowserNode(): Promise<WindowsNode | null> {
  if (!chatBrowsersOnWindows()) return null;
  if (foundNode && existsSync(foundNode.node) && existsSync(foundNode.npx)) return foundNode;
  const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
  foundNode = await findWindowsNode(settings?.nodePath);
  return foundNode;
}

/** The Playwright build a choice sent by a window needs (only its own fields are read) */
function buildOfChoice(choice: unknown): DownloadableBrowser | null {
  if (!choice || typeof choice !== 'object') return managedBuildOf(undefined);
  const { managed, engine } = choice as { managed?: unknown; engine?: unknown };
  return managedBuildOf({ managed: managed === true, engine } as PlaywrightBrowserChoice);
}

/** Results of the latest checks, by the build looked for ('' for none), until checked again */
const checked = new Map<string, ChatBrowserRequirements>();
let configuring = false;
/** Told when what is missing may have changed (an autoconfigure finished): every window gets it */
let notify: ((change: { configuring: boolean }) => void) | null = null;

/**
 * What opening a chat browser with this profile choice needs on Windows that is missing: Node.js
 * (npx starts Playwright's MCP server) and, for one of Playwright's own browsers, its build in
 * Windows' Playwright cache. Nothing elsewhere. Kept until `refresh` (or an autoconfigure) asks again
 */
export async function getChatBrowserRequirements(choice: unknown, options: { refresh?: boolean } = {}): Promise<ChatBrowserRequirements> {
  if (!isWindows()) return { missing: [] };
  await whenShellRuntimeReady();
  const build = buildOfChoice(choice);
  const key = build ?? '';
  let result = options.refresh ? undefined : checked.get(key);
  if (!result) {
    const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
    // Looked for as the holder looks for it: Windows' Node.js with the WSL shell, else npx as runs find it
    const node = chatBrowsersOnWindows()
      ? await findWindowsNode(settings?.nodePath)
      : await resolveCommand('npx', { refresh: options.refresh });
    const missing: ChatBrowserRequirement[] = [];
    if (!node) missing.push('node');
    if (build && !(await findManagedBrowser(build, windowsContext()))) missing.push('browserBuild');
    result = { missing, ...(build ? { build } : {}), ...(chatBrowsersOnWindows() ? { fromWsl: true } : {}) };
    checked.set(key, result);
  }
  return { ...result, ...(configuring ? { configuring: true } : {}) };
}

/**
 * A chat browser failed to open: what it needs is checked again on the next ask (something may
 * have gone since, such as Node.js), and every window is told so its drawer asks
 */
export function forgetChatBrowserRequirements(): void {
  checked.clear();
  foundNode = null;
  if (!configuring) notify?.({ configuring: false });
}

/** How often what is missing is checked again after Autoconfigure was pressed, and for how long at most */
const AUTOCONFIGURE_POLL_MS = 5000;
const AUTOCONFIGURE_POLL_LIMIT_MS = 15 * 60_000;
let poll: { timer: ReturnType<typeof setInterval>; busy: boolean } | null = null;

function stopWatchingChatBrowserRequirements(): void {
  if (poll) clearInterval(poll.timer);
  poll = null;
}

/**
 * Check what opening a chat browser with this choice needs every few seconds (after Autoconfigure:
 * whatever installs it, the drawer offers Open browser as soon as it can open), telling every window
 * when that changes, until nothing is missing or the time is up
 */
export function watchChatBrowserRequirements(choice: unknown): void {
  stopWatchingChatBrowserRequirements();
  const until = Date.now() + AUTOCONFIGURE_POLL_LIMIT_MS;
  const key = (missing: readonly string[]) => missing.join(',');
  let last = key(checked.get(buildOfChoice(choice) ?? '')?.missing ?? []);
  const current = {
    busy: false,
    timer: setInterval(() => {
      if (current.busy) return;
      if (Date.now() > until) return stopWatchingChatBrowserRequirements();
      current.busy = true;
      foundNode = null;
      void getChatBrowserRequirements(choice, { refresh: true })
        .then((result) => {
          if (poll !== current) return;
          if (result.missing.length === 0) stopWatchingChatBrowserRequirements();
          if (key(result.missing) !== last) {
            last = key(result.missing);
            notify?.({ configuring });
          }
        }, () => undefined)
        .finally(() => {
          current.busy = false;
        });
    }, AUTOCONFIGURE_POLL_MS),
  };
  poll = current;
}

/** Where every window is told that what is missing may have changed (set by the IPC handlers) */
export function onChatBrowserRequirementsChanged(listener: (change: { configuring: boolean }) => void): void {
  notify = listener;
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
    `${name} isn't downloaded on Windows, where chat browsers run: the browser drawer's Autoconfigure downloads it, `
    + `or run in PowerShell: ${playwrightInstallCommand(build)}`
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
    `${choice.profileName} (${choice.browser}) can't run on Windows, where chat browsers run. Pick a Windows browser profile for the chat`
  );
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
    "$Host.UI.RawUI.WindowTitle = 'Workbench: set up the chat browser'",
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
    // App Installer's alias, also when the user's WindowsApps folder isn't on the PATH
    '    $winget = (Get-Command winget -ErrorAction SilentlyContinue).Source',
    "    if (-not $winget) { $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\winget.exe' }",
    '    if (-not (Test-Path $winget)) {',
    `      throw 'winget is not available. Install Node.js ${NODE_MIN_MAJOR} or newer from https://nodejs.org, then press Autoconfigure again'`,
    '    }',
    "    Write-Host 'Installing Node.js (LTS) with winget...'",
    '    & $winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements',
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
    "  Write-Host 'Done. Close this window and open the browser in Workbench.' -ForegroundColor Green",
    '} catch {',
    '  Write-Host $_ -ForegroundColor Red',
    '}',
    "Read-Host 'Press Enter to close'",
    '',
  ].join('\r\n');
}

/**
 * Autoconfigure (the browser drawer's button, shown while something is missing): a PowerShell
 * window installs Node.js and the Playwright build the chat's browser choice needs. The script is
 * chosen here, never sent by the window. When it closes, what is missing is checked again and every
 * window is told
 */
export async function autoconfigureChatBrowser(choice: unknown): Promise<ChatBrowserRequirements> {
  if (!isWindows()) throw new Error('Only on Windows');
  if (configuring) return getChatBrowserRequirements(choice);
  const dir = path.join(app.getPath('userData'), 'windows-browser');
  const script = path.join(dir, 'autoconfigure.ps1');
  await mkdir(dir, { recursive: true });
  await writeFile(script, autoconfigureScript(buildOfChoice(choice)), 'utf-8');
  // PowerShell 7 when installed, else Windows PowerShell (always there)
  const powershell = getWindowsShellPaths().powershell?.find((candidate) => existsSync(candidate)) ?? 'powershell.exe';
  // Its own console window, which the user watches and closes: opened by Start-Process from a hidden
  // PowerShell that waits for it, so its exit is the window's (a detached start from this app, which
  // has no console, gets none either: the script never ran)
  const open = `Start-Process -FilePath ${psString(powershell)} -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${psString(`"${script}"`)}) -Wait`;
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', open], {
    stdio: 'ignore',
    windowsHide: true,
  });
  configuring = true;
  let done = false;
  const finished = () => {
    if (done) return;
    done = true;
    configuring = false;
    checked.clear();
    foundNode = null;
    notify?.({ configuring: false });
  };
  child.once('error', (error) => {
    appLog.warn('[BrowserDrawer] Could not open PowerShell to set up the chat browser:', error);
    finished();
  });
  child.once('exit', finished);
  child.unref();
  watchChatBrowserRequirements(choice);
  notify?.({ configuring: true });
  return getChatBrowserRequirements(choice);
}

/** For tests: forget what was found and checked */
export function resetChatBrowserRuntimeForTests(): void {
  foundNode = null;
  checked.clear();
  configuring = false;
  stopWatchingChatBrowserRequirements();
}
