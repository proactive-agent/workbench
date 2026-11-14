/**
 * An agent window's Claude Code session as a chat ("Open as chat"): its transcript turned into the
 * chat's messages, and the point the chat resumes the session from.
 *
 * The transcript keeps every branch a rewind or an edit left behind, so only the conversation that
 * leads to its last message counts (followed back by `parentUuid`). Subagents' lines (sidechains),
 * meta lines, local command output, the summary a /compact leaves and Claude Code's notes of an
 * interrupted request are left out; the prompts the user typed and Claude's
 * replies stay, each run of Claude's lines one reply with the tools it used. The chat resumes the
 * session from the last reply, on the account the window ran it on.
 */
import { readFile } from 'fs/promises';
import type { ClaudeSessionRef, InsightsChatMessage, InsightsToolUsage } from '../../shared/types';
import { extractToolInput } from './prompts';

interface TranscriptLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  /** A compact boundary's link to the line before the compaction (its parentUuid is null) */
  logicalParentUuid?: string | null;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** The conversation summary a /compact writes as a user line */
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
}

type Block = { type?: string; text?: unknown; name?: unknown; input?: unknown };

/** The transcript's lines that lead to its last message, oldest first */
function activeBranch(lines: TranscriptLine[]): TranscriptLine[] {
  const conversation = lines.filter((line) => (line.type === 'user' || line.type === 'assistant') && !line.isSidechain && line.uuid);
  const byId = new Map(conversation.map((line) => [line.uuid!, line] as const));
  // Every line by id, to walk through the ones that aren't conversation (a compact boundary)
  const anyById = new Map(lines.filter((line) => line.uuid).map((line) => [line.uuid!, line] as const));
  const branch: TranscriptLine[] = [];
  const seen = new Set<string>();
  let current: TranscriptLine | undefined = conversation.at(-1);
  while (current?.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    if (byId.has(current.uuid)) branch.push(current);
    const parent = current.parentUuid ?? current.logicalParentUuid;
    current = parent ? anyById.get(parent) : undefined;
  }
  return branch.reverse();
}

/** What the user typed in a user line, or null for tool results, meta and command output */
function userText(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Block[]).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n')
      : '';
  if (!text.trim()) return null;
  if (/<local-command-stdout>|<local-command-stderr>|^Caveat:/.test(text)) return null;
  // Claude Code's note of a request the user interrupted (Esc), not something they typed
  if (/^\[Request interrupted by user/.test(text.trim())) return null;
  // A slash command the user ran: as they typed it
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return [command.trim(), args].filter(Boolean).join(' ');
  }
  return text.trim();
}

let counter = 0;
const messageId = () => `msg-${Date.now()}-${(counter++).toString(36)}-imported`;

/**
 * A transcript's conversation as chat messages, and where the chat resumes the session (the last
 * reply). `profileId`: the account the session ran on
 */
export async function readTranscriptAsChat(
  transcriptPath: string,
  sessionId: string,
  profileId: string | undefined
): Promise<{ messages: InsightsChatMessage[]; head?: ClaudeSessionRef }> {
  const lines = (await readFile(transcriptPath, 'utf-8'))
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as TranscriptLine] : [];
      } catch {
        return [];
      }
    });

  const messages: InsightsChatMessage[] = [];
  let reply: { text: string[]; tools: InsightsToolUsage[]; uuid: string; timestamp: Date } | null = null;
  const endReply = () => {
    if (reply && (reply.text.length > 0 || reply.tools.length > 0)) {
      const ref: ClaudeSessionRef = { sessionId, messageUuid: reply.uuid, ...(profileId ? { profileId } : {}) };
      messages.push({
        id: messageId(),
        role: 'assistant',
        content: reply.text.join('\n\n'),
        timestamp: reply.timestamp,
        ...(reply.tools.length > 0 ? { toolsUsed: reply.tools } : {}),
        claudeRef: ref,
      });
    }
    reply = null;
  };

  for (const line of activeBranch(lines)) {
    if (line.isMeta || line.isCompactSummary) continue;
    const timestamp = line.timestamp ? new Date(line.timestamp) : new Date();
    if (line.type === 'user') {
      const text = userText(line.message?.content);
      // Tool results belong to the reply they answer
      if (text === null) continue;
      endReply();
      messages.push({ id: messageId(), role: 'user', content: text, timestamp });
      continue;
    }
    reply ??= { text: [], tools: [], uuid: line.uuid!, timestamp };
    reply.uuid = line.uuid!;
    const content = line.message?.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) reply.text.push(block.text.trim());
      if (block.type === 'tool_use') {
        reply.tools.push({
          name: String(block.name ?? 'tool'),
          input: extractToolInput((block.input ?? {}) as Record<string, unknown>),
          timestamp,
        });
      }
    }
  }
  endReply();

  const head = [...messages].reverse().find((message) => message.claudeRef)?.claudeRef;
  return { messages, head };
}
