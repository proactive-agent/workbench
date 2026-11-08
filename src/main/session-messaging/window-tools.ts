/**
 * The Workbench tools of an agent window (list_sessions, message_chat; see tools.ts): one token
 * on the app's local tools server for the window's life, handed to its Claude Code with
 * `--mcp-config` through a file only the user can read, so the token isn't typed into the window
 * or shown in the process list. Inside WSL2 with NAT networking the entry is the stdio bridge, like
 * a chat turn's. The file is in a temp folder of its own (each opening its own, so a window closed
 * and opened again under the same id never loses the new file to the old one's removal); the
 * folder and token go when the window closes, and the startup sweep removes what a crash left
 * (never a running Workbench's: the dev app and the installed one may run side by side).
 *
 * Next to it, `settings.json` (passed with `--settings`) has the window accept messages from the
 * user's other sessions (`crossSessionInbound`), as task runs do: Claude Code otherwise holds a
 * message from a session in another permission mode for approval, and a window answering a chat
 * is read-only (receiving.ts). Left out when the user's own settings refuse or hold such messages.
 * Claude Code takes one `--settings`, so the file also names the theme matching the app's (what
 * claude-cli-theme.ts gives other windows), written again at every launch.
 */
import { writeFile } from 'fs/promises';
import path from 'path';
import { agentSessionName } from '../../shared/utils/session-names';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { getTaskToolsRoute, taskToolsEntry } from '../insights/claude-code-runner';
import { openMcpToolsSession, sessionToolsProvider, type TaskToolsSession } from '../insights/task-tools-server';
import { TASK_TOOLS_SERVER_NAME } from '../insights/task-tools-mcp';
import type { TerminalProcess } from '../terminal/types';
import { findWindow } from './directory';
import { makeTempFolder, removeTempFolder, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import { isSessionMessagingEnabled } from './tools';
import { stopReceiving } from './receiving';
import { claudeConfigDirs } from '../claude-profile/profile-config-dirs';
import { claudeTheme } from '../claude-cli-theme';
import { crossSessionInboundFiles, userLimitsCrossSessionInbound } from '../task-messaging/inbound-settings';

/** The settings file next to a window's MCP config (`--settings`) */
export function windowSettingsFile(mcpConfigFile: string): string {
  return path.join(path.dirname(mcpConfigFile), 'settings.json');
}

interface WindowTools {
  session: TaskToolsSession;
  dir: string;
  file: string;
  /** Messages from the user's other sessions are accepted (their own settings don't limit them) */
  acceptMessages: boolean;
}

const opened = new Map<string, Promise<WindowTools | undefined>>();

/**
 * The MCP config file with the window's Workbench tools (a host path), or undefined when messaging
 * is off, the window has no project or the tools can't be reached from where Claude Code runs
 */
export function windowToolsConfig(terminal: Pick<TerminalProcess, 'id' | 'projectPath'>): Promise<string | undefined> {
  try {
    return openWindowTools(terminal);
  } catch (error) {
    // The window starts Claude Code without the tools rather than not at all
    appLog.warn(`[SessionMessaging] Workbench tools unavailable for agent window ${terminal.id}:`, error);
    return Promise.resolve(undefined);
  }
}

function openWindowTools(terminal: Pick<TerminalProcess, 'id' | 'projectPath'>): Promise<string | undefined> {
  if (!isSessionMessagingEnabled() || !terminal.projectPath) return Promise.resolve(undefined);
  const project = projectStore.getProjects().find((candidate) => candidate.path === terminal.projectPath);
  const route = getTaskToolsRoute();
  if (!project || route === 'off') return Promise.resolve(undefined);
  let tools = opened.get(terminal.id);
  if (!tools) {
    const name = agentSessionName(terminal.id);
    tools = (async () => {
      const session = await openMcpToolsSession(sessionToolsProvider({
        projectId: project.id,
        projectPath: project.path,
        self: () => ({ kind: 'agent', name, title: findWindow(terminal.id)?.title }),
      }));
      const dir = await makeTempFolder(TEMP_FOLDER_PREFIXES.windowTools);
      const entry = await taskToolsEntry(session.mcpServer, route, dir);
      const file = path.join(dir, 'mcp.json');
      await writeFile(file, JSON.stringify({ mcpServers: { [TASK_TOOLS_SERVER_NAME]: entry } }), { encoding: 'utf-8', mode: 0o600 });
      const userLimits = await userLimitsCrossSessionInbound(crossSessionInboundFiles(claudeConfigDirs(), project.path));
      return { session, dir, file, acceptMessages: !userLimits };
    })().catch((error) => {
      appLog.warn(`[SessionMessaging] Workbench tools unavailable for agent window ${terminal.id}:`, error);
      opened.delete(terminal.id);
      return undefined;
    });
    opened.set(terminal.id, tools);
  }
  return tools.then(async (value) => {
    if (!value) return undefined;
    // Launch time decides the theme (the app's may have changed since the window opened)
    const settings = { theme: claudeTheme(), ...(value.acceptMessages ? { crossSessionInbound: 'accept' } : {}) };
    await writeFile(windowSettingsFile(value.file), JSON.stringify(settings), 'utf-8');
    return value.file;
  }).catch((error) => {
    // A missing --settings file would stop Claude Code: start without the tools instead
    appLog.warn(`[SessionMessaging] Could not write the settings of agent window ${terminal.id}:`, error);
    return undefined;
  });
}

/** The window closed: its token stops working, its file goes and it no longer answers a message */
export function closeWindowTools(terminalId: string): void {
  stopReceiving(terminalId);
  const tools = opened.get(terminalId);
  opened.delete(terminalId);
  void tools?.then(async (value) => {
    if (!value) return;
    value.session.close();
    await removeTempFolder(value.dir);
  }).catch(() => undefined);
}
