/**
 * Stable names of a project's Claude chats and agent windows, for messaging between them
 * (main: session-messaging/). They stay the same for a chat or window's whole life, unlike its
 * Claude Code session id (a chat forks a new session on an edit, a window starts one on /clear),
 * and the copy buttons hand them to the user:
 *
 * - a chat: `chat-` and its id's timestamp in base 36 (chat ids are `session-<ms>`)
 * - an agent window: `agent-` and the first 8 characters of its id (a UUID)
 *
 * Pasted into a chat's composer or an agent window, a name is taken as the message's recipient
 * (`parseSessionName`): the composer shows it as an attachment, a window types it as
 * `[Chat #<hash>]` or `[Agent #<hash>]` (`sessionNameTag`).
 */

const CHAT_PREFIX = 'chat-';
const AGENT_PREFIX = 'agent-';
const CHAT_ID_PATTERN = /^session-(\d+)$/;

/** A chat's stable name, or null for an id that isn't a saved chat's */
export function chatSessionName(chatId: string): string | null {
  const stamp = CHAT_ID_PATTERN.exec(chatId)?.[1];
  return stamp ? `${CHAT_PREFIX}${Number(stamp).toString(36)}` : null;
}

/** The chat id a chat name stands for, or null when it isn't a chat name */
export function chatIdFromName(name: string): string | null {
  const value = name.trim().toLowerCase();
  if (!value.startsWith(CHAT_PREFIX)) return null;
  const encoded = value.slice(CHAT_PREFIX.length);
  if (!/^[0-9a-z]+$/.test(encoded)) return null;
  const stamp = parseInt(encoded, 36);
  return Number.isSafeInteger(stamp) && stamp > 0 ? `session-${stamp}` : null;
}

/** An agent window's stable name */
export function agentSessionName(terminalId: string): string {
  return `${AGENT_PREFIX}${terminalId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

/** A session name found in text: which kind, the whole name and what follows its prefix */
export interface ParsedSessionName {
  kind: 'chat' | 'agent';
  name: string;
  hash: string;
}

/** The session name a text is (all of it, spaces around aside), or null when it isn't one */
export function parseSessionName(text: string): ParsedSessionName | null {
  const value = text.trim().toLowerCase();
  const agent = /^agent-([0-9a-f]{8})$/.exec(value);
  if (agent) return { kind: 'agent', name: value, hash: agent[1] };
  const chat = /^chat-([0-9a-z]{1,13})$/.exec(value);
  return chat && chatIdFromName(value) ? { kind: 'chat', name: value, hash: chat[1] } : null;
}

/** How an agent window types a session name it was pasted: `[Chat #<hash>]` or `[Agent #<hash>]` */
export function sessionNameTag(parsed: Pick<ParsedSessionName, 'kind' | 'hash'>): string {
  return `[${parsed.kind === 'chat' ? 'Chat' : 'Agent'} #${parsed.hash}]`;
}
