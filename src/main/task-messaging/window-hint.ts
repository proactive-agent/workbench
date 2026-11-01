/**
 * Agent windows and running tasks
 * ===============================
 *
 * Task runs are Claude Code sessions named `wb-<projectKey>-<specId>` that accept cross-session
 * messages while Settings > Agents allows it (Task messaging and Messages from your Claude
 * sessions). An agent window's session is told so in one line of its `--append-system-prompt`,
 * so it can reach a running task of its project with Claude Code's built-in SendMessage.
 *
 * Windows keep Claude Code's own session names: `--name` would replace the title the Session
 * menu and `/resume` show. ListAgents lists them anyway, so tasks can reach them too.
 */
import type { AppSettings } from '../../shared/types/settings';
import { projectKey } from '../../shared/utils/task-messaging';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';

/** The hint for an agent window of the project at `projectPath`, or '' when it doesn't apply */
export function agentWindowMessagingHint(projectPath: string | undefined): string {
  if (!projectPath) return '';
  const settings = resolveClaudeCodeTaskSettings(((readSettingsFile() ?? {}) as Partial<AppSettings>).claudeCodeTasks);
  if (!settings.taskMessaging || !settings.sessionMessages) return '';
  const project = projectStore.getProjects().find((candidate) => candidate.path === projectPath);
  if (!project) return '';
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
