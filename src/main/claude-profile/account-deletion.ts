/**
 * Deleting a Claude account found in Claude Code's configuration (Settings > Accounts, the
 * account's Details), so nothing of it is left for detection to list again:
 *
 * - a subscription sign-in is signed out with Claude Code's own `claude auth logout` on its config
 *   dir, which removes its credentials (macOS Keychain entry or `.credentials.json`) and the
 *   account in its `.claude.json`
 * - any other config dir (`~/.claude-*`, CLAUDE_CONFIG_DIR) is then removed with everything in it
 * - Claude Code's default `~/.claude` stays (it holds the user's settings, skills, plugins and
 *   history for every account): its settings.json loses the variables and keys that set up how it
 *   reaches Claude (provider switches, keys, tokens, base URLs); model choices stay
 *
 * Nothing is removed when the sign-out fails.
 */
import { readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import type { ClaudeProfile } from '../../shared/types';
import { getToolInfoAsync } from '../cli-tool-manager';
import { runTool } from '../platform/runtime-exec';
import { getClaudeHome, isClaudeHomeInWsl } from '../platform/claude-home';
import { isWindows } from '../platform';
import { clearKeychainCache } from './credential-utils';
import { SETUP_CREDENTIAL_SETTINGS } from './claude-code-detection';

const LOGOUT_TIMEOUT_MS = 30_000;

function pathApi(): typeof path {
  return isClaudeHomeInWsl() ? path.win32 : path;
}

/** Sign the config dir's subscription account out with Claude Code's own logout */
async function signOut(configDir: string, isDefaultDir: boolean): Promise<void> {
  const claude = await getToolInfoAsync('claude', { refreshIfMissing: true });
  if (!claude.found || !claude.path) throw new Error('Claude Code CLI not found, so the account could not be signed out');
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  // Claude Code's default ~/.claude runs without CLAUDE_CONFIG_DIR
  if (isDefaultDir) delete env.CLAUDE_CONFIG_DIR;
  await runTool('claude', ['auth', 'logout'], { command: claude.path, env, timeout: LOGOUT_TIMEOUT_MS });
  clearKeychainCache(configDir);
}

/**
 * A dir that is safe to remove as a whole: not a filesystem root, and neither the home dir nor
 * one of its ancestors
 */
function isRemovableConfigDir(dir: string): boolean {
  const paths = pathApi();
  const resolved = paths.resolve(dir);
  const home = paths.resolve(getClaudeHome());
  const same = (a: string, b: string) => (isWindows() || isClaudeHomeInWsl() ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(resolved, paths.parse(resolved).root)) return false;
  const relative = paths.relative(resolved, home);
  // The home dir itself or a dir above it
  return !(same(resolved, home) || (relative && !relative.startsWith('..') && !paths.isAbsolute(relative)));
}

/** Remove the variables and keys that set up how the dir reaches Claude from its settings.json */
async function stripSetupSettings(configDir: string): Promise<void> {
  const file = pathApi().join(configDir, 'settings.json');
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch {
    return;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Claude Code can't read it either; leave the user's file as it is
    return;
  }
  if (!data || typeof data !== 'object') return;

  let changed = false;
  for (const key of SETUP_CREDENTIAL_SETTINGS.settings) {
    if (key in data) {
      delete data[key];
      changed = true;
    }
  }
  const env = data.env;
  if (env && typeof env === 'object') {
    const vars = env as Record<string, unknown>;
    for (const name of SETUP_CREDENTIAL_SETTINGS.env) {
      if (name in vars) {
        delete vars[name];
        changed = true;
      }
    }
    if (Object.keys(vars).length === 0) delete data.env;
  }
  if (changed) await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/** Delete a detected account's sign-in and configuration (see the file comment) */
export async function deleteClaudeCodeAccountFiles(profile: ClaudeProfile): Promise<void> {
  const detected = profile.detected;
  const configDir = profile.configDir;
  if (!detected || !configDir) throw new Error("Not an account from Claude Code's configuration");

  if (!detected.isDefaultDir && !isRemovableConfigDir(configDir)) {
    throw new Error(`Refusing to remove ${configDir}`);
  }

  // A subscription sign-in (also one behind another provider) is signed out first
  if (detected.provider === 'subscription' || detected.email) {
    await signOut(configDir, detected.isDefaultDir);
  }

  if (detected.isDefaultDir) {
    await stripSetupSettings(configDir);
  } else {
    await rm(configDir, { recursive: true, force: true });
  }
}
