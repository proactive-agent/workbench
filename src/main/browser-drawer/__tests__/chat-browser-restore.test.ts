import os, { hostname } from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));
const copies = vi.hoisted(() => ({ root: '', kept: [] as string[], removed: [] as string[] }));
vi.mock('../../browser-profiles/profile-copy', () => ({
  isBrowserProfileCopyPath: (dir: string) => dir.startsWith(copies.root),
  keepBrowserProfileCopy: async (dir: string) => {
    copies.kept.push(dir);
    return true;
  },
  removeBrowserProfileCopy: async (dir: string) => {
    copies.removed.push(dir);
  },
}));

import {
  CHAT_BROWSER_RECORD,
  RESTORE_MAX_AGE_MS,
  discardRestorable,
  keepsForChat,
  parseChatBrowserRecord,
  scanChatBrowserLeftovers,
  tabsToRestore,
  type ChatBrowserRecord,
} from '../chat-browser-restore';
import { OWNER_FILE, processIdentity } from '../../folder-owner';

const DEAD_PID = 2 ** 22 + 12345;
const NOW = Date.now();
let parent: string;

const record = (chatId: string, extra: Partial<ChatBrowserRecord> = {}): ChatBrowserRecord => ({
  projectId: 'p1',
  projectPath: '/old/path',
  chatId,
  browserId: 'chrome:Default',
  profileCopyDir: path.join(copies.root, `copy-${chatId}`),
  tabs: [{ url: 'https://example.com/', title: 'Example' }, { url: 'about:blank', title: '' }],
  updatedAt: NOW - 1000,
  ...extra,
});

async function leftover(name: string, value: ChatBrowserRecord | null, owner: object = { pid: DEAD_PID, host: hostname() }): Promise<string> {
  const dir = path.join(parent, `workbench-chat-browser-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, OWNER_FILE), JSON.stringify(owner));
  if (value) await writeFile(path.join(dir, CHAT_BROWSER_RECORD), JSON.stringify(value));
  return dir;
}

describe('chat browsers left by a crash', () => {
  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'wb-chat-restore-'));
    copies.root = path.join(parent, 'copies');
    copies.kept = [];
    copies.removed = [];
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('reads records and the tabs worth opening again', () => {
    expect(parseChatBrowserRecord('{')).toBeNull();
    expect(parseChatBrowserRecord(JSON.stringify({ projectId: 'p' }))).toBeNull();
    const parsed = parseChatBrowserRecord(JSON.stringify({ ...record('session-1'), tabs: [{ url: 'x' }, { url: 'https://a.test', title: 'A' }] }));
    expect(parsed?.tabs).toEqual([{ url: 'https://a.test', title: 'A' }]);
    expect(tabsToRestore(record('session-1').tabs)).toEqual([{ url: 'https://example.com/', title: 'Example' }]);
  });

  it('keeps one for its chat while the chat exists and it is recent', () => {
    const context = { now: NOW, projectPath: '/p', chatExists: true };
    expect(keepsForChat(record('session-1'), context)).toBe(true);
    expect(keepsForChat(record('session-1'), { ...context, chatExists: false })).toBe(false);
    expect(keepsForChat(record('session-1'), { ...context, projectPath: undefined })).toBe(false);
    expect(keepsForChat(record('session-1', { updatedAt: NOW - RESTORE_MAX_AGE_MS - 1 }), context)).toBe(false);
    expect(keepsForChat(null, context)).toBe(false);
  });

  it('keeps the newest of each existing chat, removes the rest with their copies, and leaves running ones', async () => {
    const kept = await leftover('kept', record('session-1'));
    const older = await leftover('older', record('session-1', { updatedAt: NOW - 5000, profileCopyDir: path.join(copies.root, 'copy-older') }));
    const deletedChat = await leftover('deleted', record('session-2'));
    const expired = await leftover('expired', record('session-3', { updatedAt: NOW - RESTORE_MAX_AGE_MS - 1 }));
    const otherProject = await leftover('project', record('session-1', { projectId: 'gone' }));
    const noRecord = await leftover('none', null);
    const outside = await leftover('outside', record('session-4', { profileCopyDir: path.join(os.homedir(), 'not-a-copy') }));
    const running = await leftover('running', record('session-5'), await processIdentity(process.ppid));

    const restorable = await scanChatBrowserLeftovers({
      parent,
      now: NOW,
      projects: [{ id: 'p1', path: '/project' }],
      chatExists: async (projectPath, chatId) => projectPath === '/project' && ['session-1', 'session-3', 'session-5'].includes(chatId),
    });

    expect(restorable).toEqual([{ dir: kept, record: { ...record('session-1'), projectPath: '/project' } }]);
    expect(copies.kept).toEqual([path.join(copies.root, 'copy-session-1')]);
    // This process holds it now
    expect(JSON.parse(await readFile(path.join(kept, OWNER_FILE), 'utf-8'))).toMatchObject({ pid: process.pid });
    for (const dir of [older, deletedChat, expired, otherProject, noRecord, outside]) expect(existsSync(dir)).toBe(false);
    expect(existsSync(running)).toBe(true);
    // A record naming a folder that isn't a profile copy never gets it removed
    expect(copies.removed.sort()).toEqual([
      path.join(copies.root, 'copy-older'),
      path.join(copies.root, 'copy-session-1'),
      path.join(copies.root, 'copy-session-2'),
      path.join(copies.root, 'copy-session-3'),
    ].sort());

    copies.removed = [];
    await discardRestorable(restorable[0]);
    expect(existsSync(kept)).toBe(false);
    expect(copies.removed).toEqual([path.join(copies.root, 'copy-session-1')]);
  });
});
