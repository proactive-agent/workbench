/**
 * A pasted session name (`chat-…`, `agent-…`: shared/utils/session-names.ts) as the recipient of
 * a message: one of the project's chats or agent windows, other than the one it is pasted into,
 * while chats and agent windows may message each other (Settings > Agents). The chat's composer
 * shows it as an attachment; an agent window types it as `[Chat #…]` / `[Agent #…]`. A closed agent
 * window's name counts too (the app keeps the sessions windows started): messaging it opens it again.
 */
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../shared/types/claude-code';
import { agentSessionName, chatSessionName, parseSessionName, type ParsedSessionName } from '../../shared/utils/session-names';
import { useSettingsStore } from '../stores/settings-store';
import { isProjectTerminal, useTerminalStore } from '../stores/terminal-store';
import { useInsightsStore } from '../stores/insights-store';

/** The chat or agent window a message goes to */
export interface SessionTarget extends ParsedSessionName {
  title?: string;
}

/** Whether chats and agent windows may message each other (Settings > Agents) */
export function sessionMessagingOn(): boolean {
  const stored = useSettingsStore.getState().settings.claudeCodeTasks;
  const taskMessaging = stored?.taskMessaging ?? DEFAULT_CLAUDE_CODE_TASK_SETTINGS.taskMessaging;
  const sessionMessages = stored?.sessionMessages ?? DEFAULT_CLAUDE_CODE_TASK_SETTINGS.sessionMessages;
  return taskMessaging && sessionMessages;
}

/** The project's agent window a name stands for */
function agentWindow(projectPath: string, name: string): SessionTarget | null {
  const terminal = useTerminalStore.getState().terminals.find(
    (candidate) => isProjectTerminal(candidate, projectPath) && agentSessionName(candidate.id) === name
  );
  const parsed = parseSessionName(name);
  return terminal && parsed ? { ...parsed, title: terminal.title } : null;
}

/** Whether a pasted text is an agent window's name the app should be asked about (a closed window's) */
export function mayNameClosedAgent(text: string, projectPath: string | undefined, selfName?: string | null): boolean {
  const parsed = parseSessionName(text);
  return parsed?.kind === 'agent' && !!projectPath && parsed.name !== selfName && sessionMessagingOn();
}

/** A closed agent window of the project a pasted name stands for, asked of the app; null when none had it */
export async function closedAgentWindow(text: string, projectPath: string | undefined, selfName?: string | null): Promise<SessionTarget | null> {
  if (!mayNameClosedAgent(text, projectPath, selfName)) return null;
  const parsed = parseSessionName(text)!;
  const match = await window.electronAPI.findAgentWindow(projectPath!, parsed.name).catch(() => null);
  return match ? { ...parsed, ...(match.title ? { title: match.title } : {}) } : null;
}

/**
 * The name of the Claude Code session an agent window has open, as `/resume` and the window's
 * Session menu show it; undefined while it has none or it can't be read
 */
export async function windowSessionTitle(projectPath: string, name: string): Promise<string | undefined> {
  const terminal = useTerminalStore.getState().terminals.find(
    (candidate) => isProjectTerminal(candidate, projectPath) && agentSessionName(candidate.id) === name
  );
  if (!terminal) return undefined;
  const result = await window.electronAPI.listClaudeSessions(terminal.id).catch(() => null);
  return result?.success ? result.data?.find((session) => session.current)?.name : undefined;
}

/** The chat a name stands for, among a project's chats */
function chatAmong(chats: Array<{ id: string; title?: string }>, name: string): SessionTarget | null {
  const chat = chats.find((candidate) => chatSessionName(candidate.id) === name);
  const parsed = parseSessionName(name);
  return chat && parsed ? { ...parsed, title: chat.title } : null;
}

/**
 * The recipient a pasted text names, from what the app holds now (the Claude page's chats and the
 * agent windows): for the chat composer, which decides while the paste event runs. `selfName`: the
 * chat or window it is pasted into
 */
export function sessionTargetNow(text: string, projectPath: string | undefined, selfName?: string | null): SessionTarget | null {
  const parsed = parseSessionName(text);
  if (!parsed || !projectPath || parsed.name === selfName || !sessionMessagingOn()) return null;
  if (parsed.kind === 'agent') return agentWindow(projectPath, parsed.name);
  return chatAmong(useInsightsStore.getState().sessions, parsed.name);
}

/**
 * The recipient a pasted text names, asking for the project's chats when the app doesn't hold
 * them: for an agent window, which types the paste once it knows
 */
export async function sessionTarget(
  text: string,
  project: { id: string; path: string } | undefined,
  selfName?: string | null
): Promise<SessionTarget | null> {
  const parsed = parseSessionName(text);
  if (!parsed || !project || parsed.name === selfName || !sessionMessagingOn()) return null;
  if (parsed.kind === 'agent') return agentWindow(project.path, parsed.name) ?? closedAgentWindow(text, project.path, selfName);
  const insights = useInsightsStore.getState();
  if (insights.projectId === project.id && insights.sessions.length > 0) return chatAmong(insights.sessions, parsed.name);
  const result = await window.electronAPI.listInsightsSessions(project.id).catch(() => null);
  return result?.success && result.data ? chatAmong(result.data, parsed.name) : null;
}
