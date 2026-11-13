/**
 * Commands MCP servers need
 * =========================
 *
 * A stdio MCP server can only start when its command is installed where Claude Code runs (the
 * built-in connectors need npx; custom servers name their own command). Lookups are cached;
 * `refresh` looks again (after installing something). See mcp-availability.ts.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { isWindows } from './platform';
import { getWslInfo, whenShellRuntimeReady } from './platform/shell-runtime';
import { execInWsl } from './platform/wsl-exec-basic';
import { isUnderMountRoot } from './platform/wsl-detect';
import { getWhereExePath } from './utils/windows-paths';
import { getToolInfoAsync } from './cli-tool-manager';
import { getToolEnvAsync } from './cli-utils';

const execFileAsync = promisify(execFile);

/**
 * Where a command lives inside WSL (`command -v` with the login PATH), when the app runs its
 * tools there. `windowsOnly` when only a Windows program of that name was found (on the Windows
 * PATH WSL appends), which Claude Code inside WSL can't use as an MCP server.
 */
export async function findWslCommand(command: string): Promise<{ path: string | null; windowsOnly: boolean }> {
  const wsl = getWslInfo();
  if (!wsl) return { path: null, windowsOnly: false };
  let found = '';
  try {
    // Without the login PATH's Windows entries removed, so a Windows-only program can be named
    const { stdout } = await execInWsl('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { timeout: 15000 });
    found = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  } catch {
    return { path: null, windowsOnly: false };
  }
  if (!found.startsWith('/')) return { path: null, windowsOnly: false };
  if (isUnderMountRoot(found, wsl.mountRoot)) return { path: null, windowsOnly: true };
  return { path: found, windowsOnly: false };
}

/** Extensions Windows runs a bare command name with (PATHEXT) */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}

/**
 * The first of where.exe's matches Windows can start. where.exe also lists files without an
 * extension (npm ships a POSIX `npx` script next to `npx.cmd`), which spawn can't run
 */
export function pickWindowsMatch(output: string, extensions: string[]): string | null {
  const matches = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return matches.find((match) => extensions.includes(path.extname(match).toLowerCase())) ?? null;
}

async function lookUp(command: string): Promise<string | null> {
  await whenShellRuntimeReady();
  if (getWslInfo()) return (await findWslCommand(command)).path;
  // node and npx come from the Node.js detection (version managers included): npx sits next to node
  if (command === 'node' || command === 'npx') {
    const node = await getToolInfoAsync('node');
    if (!node.found || !node.path) return null;
    if (command === 'node') return node.path;
    const npx = path.join(path.dirname(node.path), isWindows() ? 'npx.cmd' : 'npx');
    return existsSync(npx) ? npx : null;
  }
  if (path.isAbsolute(command)) return existsSync(command) ? command : null;
  try {
    const env = await getToolEnvAsync();
    const { stdout } = await execFileAsync(isWindows() ? getWhereExePath() : 'which', [command], {
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (isWindows()) return pickWindowsMatch(stdout, windowsExtensions(env));
    return stdout.trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

const lookups = new Map<string, Promise<string | null>>();

/**
 * Where a command is installed where Claude Code runs, or null: a full path natively (on Windows
 * with the extension spawn needs, such as `npx.cmd`), a Linux path in WSL. Cached; `refresh`
 * looks again
 */
export async function resolveCommand(command: string, options: { refresh?: boolean } = {}): Promise<string | null> {
  // Per runtime (once it is known): code run natively in a WSL session (runNatively) looks on Windows
  await whenShellRuntimeReady();
  const key = `${getWslInfo() ? 'wsl' : 'native'}:${command}`;
  if (options.refresh) lookups.delete(key);
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = lookUp(command);
    lookups.set(key, lookup);
  }
  return lookup;
}

/** Whether a command is installed where Claude Code runs (cached; `refresh` looks again) */
export async function isCommandAvailable(command: string, options: { refresh?: boolean } = {}): Promise<boolean> {
  return (await resolveCommand(command, options)) !== null;
}

/** Forget every lookup (after tool paths or the shell runtime changed) */
export function resetCommandLookups(): void {
  lookups.clear();
}
