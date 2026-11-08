/**
 * Claude Code's own light/dark theme for the sessions the app starts in agent windows.
 *
 * An agent window paints its text with the app's terminal colors, while Claude Code colors its
 * own output - syntax highlighting above all - from the theme in its settings. With the two out
 * of step, a dark-themed CLI in a light agent window writes near-white code on a near-white
 * background, readable only while it's selected. Every session the app starts therefore gets a
 * `--settings` file naming the matching theme. A file, not a JSON string, because the quoting a
 * JSON string needs differs in every shell an agent window can run (cmd.exe, PowerShell 5,
 * POSIX shells).
 */

import { app, nativeTheme } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import {
  defaultShellKind,
  escapeForWindowsDoubleQuote,
  escapePowerShellArg,
  escapeShellArg
} from '../shared/utils/shell-escape';
import type { ShellKind } from '../shared/types/terminal';
import { readSettingsFile } from './settings-utils';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { appLog } from './app-logger';
import { isWslRuntime, toRuntimePath } from './platform/shell-runtime';

/** Claude Code's two base themes; both files are written at startup */
const CLAUDE_THEMES = ['dark', 'light'] as const;

type ClaudeTheme = (typeof CLAUDE_THEMES)[number];

function themeSettingsPath(theme: ClaudeTheme): string {
  return path.join(app.getPath('userData'), `claude-theme-${theme}.json`);
}

/**
 * Write the settings files that agent windows point Claude Code at. Called once on startup, so
 * launching a session only has to name one of them.
 */
export function writeClaudeThemeSettings(): void {
  for (const theme of CLAUDE_THEMES) {
    try {
      writeFileSync(themeSettingsPath(theme), `${JSON.stringify({ theme }, null, 2)}\n`, 'utf-8');
    } catch (error) {
      appLog.warn(`[claude-cli-theme] Could not write the ${theme} settings file:`, error);
    }
  }
}

/**
 * Whether the app is showing its dark colors, decided the way the renderer decides it: the app's
 * theme setting, or Electron's view of the OS for "system" - the same answer
 * `prefers-color-scheme` gives the window, so the CLI's theme and the window's never disagree.
 */
function isAppDark(): boolean {
  const theme = readSettingsFile()?.theme ?? DEFAULT_APP_SETTINGS.theme;
  if (theme === 'light') return false;
  if (theme === 'system') return nativeTheme.shouldUseDarkColors;
  return true;
}

/** The Claude Code theme matching the app's */
export function claudeTheme(): ClaudeTheme {
  return isAppDark() ? 'dark' : 'light';
}

/**
 * The ` --settings <file>` flag giving Claude Code the theme that matches the app's, or an empty
 * string when the file isn't there (the session then keeps the user's own theme). Quoted for the
 * window's shell (the platform's default agent window shell when it isn't given). A POSIX window
 * in the WSL runtime gets the file's path inside WSL (`/mnt/c/...`).
 */
export function claudeThemeFlag(shellKind: ShellKind = defaultShellKind()): string {
  const file = themeSettingsPath(isAppDark() ? 'dark' : 'light');
  if (!existsSync(file)) return '';
  if (shellKind === 'powershell') return ` --settings ${escapePowerShellArg(file)}`;
  if (shellKind === 'cmd') return ` --settings "${escapeForWindowsDoubleQuote(file)}"`;
  return ` --settings ${escapeShellArg(isWslRuntime() ? toRuntimePath(file) : file)}`;
}
