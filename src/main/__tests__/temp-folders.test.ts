import os, { hostname } from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));

import { makeTempFolder, noteTempFolderRun, removeLeftoverTempFolders, removeTempFolder, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import { OWNER_FILE, processIdentity } from '../folder-owner';

/** A process id nothing runs as */
const DEAD_PID = 2 ** 22 + 12345;

let parent: string;

async function folder(name: string, owner?: object): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  if (owner) await writeFile(path.join(dir, OWNER_FILE), JSON.stringify(owner));
  return dir;
}

describe('Workbench temp folders', () => {
  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'wb-temp-folders-'));
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('makes a folder owned by this process and removes it', async () => {
    const dir = await makeTempFolder(TEMP_FOLDER_PREFIXES.task, parent);
    expect(path.basename(dir).startsWith('workbench-task-')).toBe(true);
    expect(existsSync(path.join(dir, OWNER_FILE))).toBe(true);
    await removeTempFolder(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes only what no running Workbench or run holds', async () => {
    const own = await makeTempFolder(TEMP_FOLDER_PREFIXES.chatTurn, parent);
    const crashed = await folder('workbench-task-crashed', { pid: DEAD_PID, host: hostname() });
    const otherWorkbench = await folder('workbench-insights-other', await processIdentity(process.ppid));
    const runGoesOn = await folder('workbench-task-running', { pid: DEAD_PID, host: hostname() });
    await noteTempFolderRun(runGoesOn, process.ppid);
    const runEnded = await folder('workbench-insights-ended', { pid: DEAD_PID, host: hostname() });
    await noteTempFolderRun(runEnded, DEAD_PID);
    const unownedNew = await folder('workbench-mcp-probe-new');
    const unownedOld = await folder('workbench-mcp-probe-old');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(unownedOld, twoHoursAgo, twoHoursAgo);
    const chatBrowser = await folder('workbench-chat-browser-x', { pid: DEAD_PID, host: hostname() });
    const notOurs = await folder('something-else', { pid: DEAD_PID, host: hostname() });

    const removed = await removeLeftoverTempFolders({ parent, skip: [TEMP_FOLDER_PREFIXES.chatBrowser] });

    expect(removed.sort()).toEqual([crashed, runEnded, unownedOld].sort());
    for (const dir of [own, otherWorkbench, runGoesOn, unownedNew, chatBrowser, notOurs]) expect(existsSync(dir)).toBe(true);
    await removeTempFolder(own);
  });

  it('has nothing to do without the temp folder', async () => {
    expect(await removeLeftoverTempFolders({ parent: path.join(parent, 'missing') })).toEqual([]);
  });
});
