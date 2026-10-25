/**
 * Claude Code sessions of a directory
 * ===================================
 *
 * What `/resume` offers in a directory: the account's transcripts of that directory, newest first,
 * without headless (`claude -p`) runs and without transcripts that hold no conversation (Claude Code
 * also writes files with nothing but a session title). Each one is named the way Claude Code names
 * it: a title set for it, else the title Claude gave it, else its session name, else its latest
 * prompt.
 *
 * Transcripts can be large, so only their start (the first prompt says how the session was run) and
 * their end (the newest title records) are read.
 */

import { promises as fsp } from 'fs';
import path from 'path';
import { getSessionFilePath } from '../claude-profile/session-utils';
import type { ClaudeSessionItem } from '../../shared/types';

/** Bytes read from each end of a transcript */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
/** Sessions listed at most (newest first) */
const MAX_SESSIONS = 50;
/** Transcripts looked into at most, so a folder of empty ones can't make the list slow */
const MAX_SCANNED = 200;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

interface TranscriptSummary {
  hasConversation: boolean;
  /** How the first prompt was run: `cli` interactive, `sdk-cli` headless */
  entrypoint?: string;
  name?: string;
}

/** The start and the end of a file (the whole file when it is small) */
async function readEnds(file: string, size: number): Promise<{ head: string; tail: string }> {
  const handle = await fsp.open(file, 'r');
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString('utf-8');
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const all = await read(0, size);
      return { head: all, tail: all };
    }
    return { head: await read(0, HEAD_BYTES), tail: await read(size - TAIL_BYTES, TAIL_BYTES) };
  } finally {
    await handle.close();
  }
}

function parseLines(text: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line cut where the read stopped
    }
  }
  return records;
}

/** The text of a user prompt, short */
function promptText(record: Record<string, unknown>): string | undefined {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : '')).join(' ')
      : '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  // Command and system wrappers are not what the user asked
  if (!trimmed || trimmed.startsWith('<')) return undefined;
  return trimmed;
}

/** What `/resume` needs from one transcript */
export function summarizeTranscript(head: string, tail: string): TranscriptSummary {
  const headRecords = parseLines(head);
  const tailRecords = head === tail ? headRecords : parseLines(tail);
  const all = head === tail ? headRecords : [...headRecords, ...tailRecords];

  const isMessage = (record: Record<string, unknown>) => record.type === 'user' || record.type === 'assistant';
  const firstUser = headRecords.find((record) => record.type === 'user' && !record.isMeta && !record.isSidechain);

  // The newest record of each kind wins (a title can be changed)
  const latest = (type: string, field: string): string | undefined => {
    for (let i = all.length - 1; i >= 0; i--) {
      const value = all[i].type === type ? all[i][field] : undefined;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const firstPrompt = headRecords
    .filter((record) => record.type === 'user' && !record.isMeta && !record.isSidechain)
    .map(promptText)
    .find(Boolean);

  return {
    hasConversation: all.some(isMessage),
    entrypoint: typeof firstUser?.entrypoint === 'string' ? firstUser.entrypoint : undefined,
    name: latest('custom-title', 'customTitle')
      ?? latest('ai-title', 'aiTitle')
      ?? latest('agent-name', 'agentName')
      ?? latest('last-prompt', 'lastPrompt')
      ?? firstPrompt,
  };
}

/**
 * The sessions `/resume` lists for a directory under one account: newest first, interactive ones
 * with a conversation only. `cwd` is the directory as Claude Code sees it (the runtime path).
 */
export async function listDirectorySessions(configDir: string, cwd: string): Promise<Omit<ClaudeSessionItem, 'current'>[]> {
  const folder = path.dirname(getSessionFilePath(configDir, cwd, 'session'));
  let entries: string[];
  try {
    entries = await fsp.readdir(folder);
  } catch {
    // Nothing has run in this directory on this account
    return [];
  }

  const files = (await Promise.all(
    entries
      .filter((entry) => SESSION_FILE.test(entry))
      .map(async (entry) => {
        const file = path.join(folder, entry);
        try {
          const stats = await fsp.stat(file);
          return stats.isFile() ? { file, sessionId: entry.slice(0, -'.jsonl'.length), size: stats.size, modifiedAt: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      })
  )).filter((file): file is NonNullable<typeof file> => file !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, MAX_SCANNED);

  const sessions: Omit<ClaudeSessionItem, 'current'>[] = [];
  for (const file of files) {
    if (sessions.length >= MAX_SESSIONS) break;
    try {
      const { head, tail } = await readEnds(file.file, file.size);
      const summary = summarizeTranscript(head, tail);
      if (!summary.hasConversation || summary.entrypoint === 'sdk-cli') continue;
      sessions.push({ sessionId: file.sessionId, name: summary.name, modifiedAt: file.modifiedAt });
    } catch {
      // Removed or unreadable while listing
    }
  }
  return sessions;
}
