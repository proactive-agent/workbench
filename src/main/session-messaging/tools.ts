/**
 * Messaging between a project's Claude chats and agent windows
 * ============================================================
 *
 * Both get two Workbench tools (MCP server `workbench`, served by the app's local tools server
 * with a token per chat turn or agent window), and address each other by stable names
 * (shared/utils/session-names.ts) the user copies from the chat and the window:
 *
 *   list_sessions  the project's chats and agent windows: name, title, whether busy, and for a
 *                  window the name Claude Code's SendMessage reaches its session by
 *   message_chat   send a message to a chat. A chat runs only while it replies, so Workbench
 *                  delivers it: the message shows in the chat, marked with its sender, and the
 *                  chat replies to it (after the reply it is writing, if any)
 *
 * Agent windows are live Claude Code sessions, so a message to one goes through Claude Code's
 * own SendMessage (its inbound rules apply: a message can't approve a prompt or change settings).
 *
 * On while Settings > Agents has Task messaging and Messages from your Claude sessions on.
 */
import type { SessionMessageOrigin } from '../../shared/types';
import type { AppSettings } from '../../shared/types/settings';
import { chatIdFromName, chatSessionName, agentSessionName } from '../../shared/utils/session-names';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { readSettingsFile } from '../settings-utils';
import { getChatSource, projectWindows } from './directory';
import { windowLiveSession } from './live-sessions';

/** Longest message a session may send a chat */
export const MAX_SESSION_MESSAGE_LENGTH = 8000;

/** Tool names as a session sees them (`mcp__workbench__<name>`) */
export const SESSION_TOOL_NAMES = ['list_sessions', 'message_chat'] as const;

/** Whether chats and agent windows may message each other (Settings > Agents) */
export function isSessionMessagingEnabled(): boolean {
  const settings = resolveClaudeCodeTaskSettings(((readSettingsFile() ?? {}) as Partial<AppSettings>).claudeCodeTasks);
  return settings.taskMessaging && settings.sessionMessages;
}

/** Who calls the tools: a chat turn or an agent window of the project */
export interface SessionToolContext {
  projectId: string;
  projectPath: string;
  self: () => SessionMessageOrigin;
}

export interface SessionTool {
  name: (typeof SESSION_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (context: SessionToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

async function listSessions(context: SessionToolContext): Promise<unknown> {
  const self = context.self();
  const chats = (getChatSource()?.list(context.projectId, context.projectPath) ?? []).flatMap((chat) => {
    const name = chatSessionName(chat.chatId);
    return name ? [{ name, title: chat.title, replyingNow: chat.replying, ...(name === self.name ? { you: true } : {}) }] : [];
  });
  const windows = await Promise.all(projectWindows(context.projectPath).map(async (terminal) => {
    const name = agentSessionName(terminal.id);
    const live = await windowLiveSession(terminal);
    return {
      name,
      title: terminal.title,
      claudeCodeRunning: terminal.isCLIMode,
      ...(live?.name ? { sendMessageTo: live.name } : {}),
      ...(live?.status ? { status: live.status } : {}),
      ...(name === self.name ? { you: true } : {}),
    };
  }));
  return {
    you: self,
    chats,
    agentWindows: windows,
    howToMessage:
      'A chat: message_chat with its name. An agent window: SendMessage to its sendMessageTo name ' +
      '(a window without one has no Claude Code session that can take messages right now). ' +
      "Tasks: message_task where you have it, or the task's wb-… session with SendMessage.",
  };
}

async function messageChat(context: SessionToolContext, args: Record<string, unknown>): Promise<string> {
  const target = typeof args.chat === 'string' ? args.chat.trim() : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) return 'not sent: the message is empty';
  if (message.length > MAX_SESSION_MESSAGE_LENGTH) {
    return `not sent: the message is ${message.length} characters, more than ${MAX_SESSION_MESSAGE_LENGTH}; shorten it`;
  }
  const chatId = chatIdFromName(target);
  if (!chatId) return `not sent: "${target}" is not a chat name (chat-…); list_sessions lists the chats`;
  const self = context.self();
  if (self.kind === 'chat' && chatSessionName(chatId) === self.name) return 'not sent: that is this chat';
  const source = getChatSource();
  if (!source) return 'not sent: the Claude chat is not available';
  const outcome = await source.deliver(context.projectId, context.projectPath, chatId, self, message);
  switch (outcome.status) {
    case 'started':
      return `delivered: ${target} shows the message and is replying to it now`;
    case 'queued':
      return `delivered: ${target} is writing a reply; it takes the message up once that reply ends`;
    case 'held':
      return `delivered: ${target} shows the message, but it waits for the user before replying to other sessions (it answered ${outcome.answered} of their messages in a row, or others already wait); don't send it more for now`;
    default:
      return `not sent: this project has no chat named ${target} (it may have been deleted or archived)`;
  }
}

export const SESSION_TOOLS: SessionTool[] = [
  {
    name: 'list_sessions',
    description:
      "This Workbench project's Claude chats and agent windows, by the names the user copies from them (chat-…, agent-…): " +
      'title, whether a chat is replying, whether a window runs Claude Code, and for a window the name to SendMessage it by. ' +
      'Use it to find who to message, or what a name the user gave you stands for.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    run: (context) => listSessions(context),
  },
  {
    name: 'message_chat',
    description:
      'Send a message to one of the project\'s Claude chats. Workbench shows it in that chat, marked as from you, and the chat ' +
      'replies to it on its own (after the reply it is writing, if any). Its answer reaches you only if it messages you back. ' +
      'Returns what happened: delivered or not sent (and why). For an agent window use SendMessage instead (see list_sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'The chat\'s name, as list_sessions or the user gives it: "chat-…"' },
        message: { type: 'string', description: `The message, up to ${MAX_SESSION_MESSAGE_LENGTH} characters. Say what you need and who you are` },
      },
      required: ['chat', 'message'],
      additionalProperties: false,
    },
    // It makes the chat reply, which may act
    readOnly: false,
    run: messageChat,
  },
];

/** Run a messaging tool; unknown tools throw */
export async function runSessionTool(context: SessionToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = SESSION_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  // Switched off after the session got its tools (a window keeps its tools while it runs)
  if (!isSessionMessagingEnabled()) {
    return 'not available: messaging between chats and agent windows is off in Workbench (Settings > Agents)';
  }
  return tool.run(context, args);
}

/** What the chat's Claude reads for a message the user sent to another chat or agent window */
export function outgoingMessageText(to: SessionMessageOrigin, text: string): string {
  const target = to.kind === 'chat' ? `the Claude chat "${to.title ?? to.name}" (${to.name})` : `the agent window "${to.title ?? to.name}" (${to.name})`;
  const how = to.kind === 'chat'
    ? `message_chat to ${to.name}`
    : `SendMessage to the sendMessageTo name list_sessions gives for ${to.name}`;
  return `[The user sends this to ${target}. Write the message from what follows (as it is when it already is the message; do first what it asks you to put together), send it with ${how}, and say in one line that it went.]\n\n${text}`;
}

/** How a message from another session reads to the receiving chat's Claude */
export function incomingMessageText(from: SessionMessageOrigin, text: string): string {
  const who = from.kind === 'chat' ? `the Claude chat "${from.title ?? from.name}" (${from.name})` : `the agent window "${from.title ?? from.name}" (${from.name})`;
  const reply = from.kind === 'chat'
    ? `answer it with message_chat to ${from.name}`
    : `answer it with SendMessage to that window (list_sessions gives the name to send to)`;
  return `[Message from ${who}, another of the user's Claude sessions in Workbench, not from the user. If it needs an answer, ${reply}.]\n\n${text}`;
}
