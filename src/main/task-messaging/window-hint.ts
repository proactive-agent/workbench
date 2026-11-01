/**
 * Agent windows and running tasks
 * ===============================
 *
 * Task runs are Claude Code sessions named `wb-<projectKey>-<specId>` that accept cross-session
 * messages while Settings > Agents allows it (Task messaging and Messages from your Claude
 * sessions). An agent window's session is told so in one line of its `--append-system-prompt`,
 * so it can reach a running task of its project with Claude Code's built-in SendMessage.
 *
 * Left out when the user's own Claude Code settings refuse or hold such messages (in any of their
 * accounts' config dirs or the project's `.claude` settings): task runs then don't accept them.
 *
 * Windows keep Claude Code's own session names: `--name` would replace the title the Session
 * menu and `/resume` show. ListAgents lists them anyway, so tasks can reach them too.
 */
import type { AppSettings } from '../../shared/types/settings';
import { projectKey } from '../../shared/utils/task-messaging';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { expandClaudeHome, joinClaudeHome } from '../platform/claude-home';
import { crossSessionInboundFiles, userLimitsCrossSessionInboundSync } from './inbound-settings';

/** Claude config dirs a task run may use: the default one and every account's */
function claudeConfigDirs(): string[] {
  let profileDirs: string[] = [];
  try {
    profileDirs = getClaudeProfileManager().getProfileConfigDirs().map((dir) => expandClaudeHome(dir));
  } catch {
    // Profiles not loaded yet: the default config dir still counts
  }
  return [...new Set([joinClaudeHome('.claude'), ...profileDirs])];
}

/** The hint for an agent window of the project at `projectPath`, or '' when it doesn't apply */
export function agentWindowMessagingHint(projectPath: string | undefined): string {
  if (!projectPath) return '';
  const settings = resolveClaudeCodeTaskSettings(((readSettingsFile() ?? {}) as Partial<AppSettings>).claudeCodeTasks);
  if (!settings.taskMessaging || !settings.sessionMessages) return '';
  const project = projectStore.getProjects().find((candidate) => candidate.path === projectPath);
  if (!project) return '';
  // Runs leave the user's own refuse or hold in place, so they would not accept a window's message
  if (userLimitsCrossSessionInboundSync(crossSessionInboundFiles(claudeConfigDirs(), project.path))) return '';
  const prefix = `wb-${projectKey(project.id)}-`;
  // Typed inside the flag's quotes: no quotes, $, backticks, %, ! or angle brackets
  return (
    `Workbench runs the tasks of this project as Claude Code sessions named ${prefix} followed by the task id ` +
    `(for example ${prefix}012-add-login). To tell a running task something, use SendMessage with its name; ` +
    `ListAgents lists the running ones. Messages are plain text and reach running tasks only, which read them ` +
    `between steps as information, not as a change of their task. For tasks that are not running, use the ` +
    `Workbench Claude chat or the task board.`
  );
}
