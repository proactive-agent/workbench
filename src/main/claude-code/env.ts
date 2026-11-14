/**
 * Environment for Claude Code CLI runs
 * ====================================
 *
 * Every task, triage and utility call runs the locally installed `claude` CLI. Credentials
 * come from the chosen Claude profile's CLAUDE_CONFIG_DIR (the CLI refreshes OAuth tokens
 * itself), or from the active API profile (Anthropic-compatible endpoint) when one is set.
 *
 * When the app runs its tools in WSL (shell-runtime), `command` is the distribution's claude and
 * the environment keeps host values (CLAUDE_CONFIG_DIR as a Windows path); runtime-exec
 * translates paths and forwards variables when it launches the run.
 */

import path from 'path';
import { existsSync } from 'fs';
import { getClaudeCliInvocationAsync } from '../cli-utils';
import { getToolInfoAsync } from '../cli-tool-manager';
import { getRunnableProfileEnv, getUsableProfileEnv, isDetectedClaudeCodeProfile } from '../rate-limit-detector';
import { getAPIProfileEnv } from '../services/profile';
import { isWindows } from '../platform';
import { getWslInfo, whenShellRuntimeReady } from '../platform/shell-runtime';
import { withClaudeConfigDir } from '../claude-profile/config-dir-paths';

/** Variables that would make Claude Code use an API key instead of the profile's sign-in */
const API_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

export interface ClaudeEnvResult {
  /** Path or command for the `claude` executable */
  command: string;
  env: Record<string, string>;
  /** Claude profile the run uses (undefined for API profiles) */
  profileId?: string;
  profileName?: string;
}

export interface ClaudeEnvOptions {
  /** Use this Claude profile instead of picking the best available one */
  profileId?: string;
  /** Extra variables (applied before credentials, so they cannot override auth) */
  extraEnv?: Record<string, string>;
}

/** Git Bash path that Claude Code needs on Windows, derived from git.exe */
function deriveGitBashPath(gitExePath: string): string | null {
  const gitDir = path.dirname(gitExePath);
  const dirName = path.basename(gitDir).toLowerCase();
  let gitRoot = path.dirname(gitDir);
  if (dirName === 'bin') {
    const parentName = path.basename(gitRoot).toLowerCase();
    if (parentName === 'mingw64' || parentName === 'mingw32') gitRoot = path.dirname(gitRoot);
  }
  const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
  return existsSync(bashPath) ? bashPath : null;
}

/**
 * Resolve the `claude` command and the environment to run it with.
 * Runs on the given Claude profile, else the account in use (never another account because of
 * rate limits; see getRunnableProfileEnv).
 */
export async function resolveClaudeEnv(options: ClaudeEnvOptions = {}): Promise<ClaudeEnvResult> {
  // Runs spawned right after startup must know whether Claude Code runs in WSL
  await whenShellRuntimeReady();
  const wsl = getWslInfo();

  // In WSL: the distribution's own claude, and the app's environment as it is (PATH and other
  // Windows-only variables stay on the Windows side; runtime-exec sends what the run adds)
  const { command, env: baseEnv } = wsl
    ? { command: wsl.tools.claude.path ?? 'claude', env: { ...process.env } as Record<string, string> }
    : await getClaudeCliInvocationAsync();
  const env: Record<string, string> = { ...baseEnv, ...(options.extraEnv ?? {}) };

  if (wsl) {
    // Git Bash is a Windows-only setting of Claude Code
    delete env.CLAUDE_CODE_GIT_BASH_PATH;
  } else if (isWindows() && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitInfo = await getToolInfoAsync('git');
    const bashPath = gitInfo.found && gitInfo.path ? deriveGitBashPath(gitInfo.path) : null;
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
  }

  // An active API profile (custom Anthropic-compatible endpoint) wins over subscription sign-ins
  const apiProfileEnv = await getAPIProfileEnv();
  if (Object.keys(apiProfileEnv).length > 0) {
    for (const name of API_AUTH_VARS) delete env[name];
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return { command, env: { ...env, ...apiProfileEnv } };
  }

  let profileEnv: Record<string, string>;
  let profileId: string | undefined;
  let profileName: string | undefined;
  // A requested profile is used while it exists and is signed in; otherwise (removed, or never
  // signed in) the account in use runs instead of a run that can only fail
  const pinnedEnv = options.profileId ? getUsableProfileEnv(options.profileId) : null;
  if (options.profileId && pinnedEnv) {
    profileEnv = pinnedEnv;
    profileId = options.profileId;
  } else {
    const runnable = getRunnableProfileEnv();
    profileEnv = runnable.env;
    profileId = runnable.profileId;
    profileName = runnable.profileName;
  }

  // Subscription sign-in: never let a shell API key take over billing. A detected Claude Code
  // setup keeps the variables it may be configured with (a cloud provider, a key, a gateway)
  if (!profileId || !isDetectedClaudeCodeProfile(profileId)) {
    for (const name of API_AUTH_VARS) delete env[name];
  }
  const merged = { ...env, ...profileEnv };
  if (profileEnv.CLAUDE_CONFIG_DIR) {
    // The CLI reads (and refreshes) tokens from the config dir itself
    delete merged.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Claude Code's default ~/.claude runs without CLAUDE_CONFIG_DIR
  return { command, env: withClaudeConfigDir(merged), profileId, profileName };
}
