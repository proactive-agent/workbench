/**
 * The profiles still chosen: Settings plus the tasks' and chats' own picks that aren't archived, per project
 * and across projects
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';

const projects = vi.hoisted(() => ({ list: [] as { path: string; autoBuildPath?: string }[] }));
vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => projects.list } }));

import { browserChoicesInUse } from '../choices-in-use';

const choice = (id: string) => ({ id, browser: 'chrome', engine: 'chromium', profileName: id, executablePath: '/c', userDataDir: '/c', profilePath: `/c/${id}` });

describe('browserChoicesInUse', () => {
  let root: string;

  async function task(project: string, name: string, metadata: unknown): Promise<void> {
    const dir = path.join(project, '.workbench', 'tasks', name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'task_metadata.json'), JSON.stringify(metadata));
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'choices-in-use-'));
    projects.list = [{ path: path.join(root, 'a'), autoBuildPath: '.workbench' }, { path: path.join(root, 'b') }];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists Settings' choice and the tasks' own picks, leaving out archived tasks and Playwright's Chromium", async () => {
    const [a, b] = projects.list.map((project) => project.path);
    await task(a, '001-own', { playwrightBrowser: choice('chrome:A') });
    await task(a, '002-archived', { playwrightBrowser: choice('chrome:Old'), archivedAt: '2026-10-01T00:00:00Z' });
    await task(a, '003-default-chrome', { playwrightBrowser: null });
    await task(a, '004-follows-settings', {});
    await task(b, '001-other', { playwrightBrowser: choice('chrome:B') });
    // A pick saved before the connector moved to Playwright
    await task(b, '002-older', { puppeteerBrowser: choice('chrome:Older') });
    await mkdir(path.join(a, '.workbench', 'tasks', '005-broken'), { recursive: true });
    await writeFile(path.join(a, '.workbench', 'tasks', '005-broken', 'task_metadata.json'), '{');

    const inUse = await browserChoicesInUse(a, choice('chrome:Settings') as never);
    expect(inUse.project.map((c) => c.id)).toEqual(['chrome:Settings', 'chrome:A']);
    expect(inUse.all.map((c) => c.id).sort()).toEqual(['chrome:A', 'chrome:B', 'chrome:Older', 'chrome:Settings']);
  });

  it("lists the chats' own picks, leaving out archived chats and chats that follow Settings", async () => {
    const [a, b] = projects.list.map((project) => project.path);
    const chat = async (project: string, name: string, content: unknown) => {
      const dir = path.join(project, '.workbench', 'chats', 'sessions');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    };
    await chat(a, 'session-1.json', { modelConfig: { playwrightBrowser: choice('firefox:Chat') } });
    await chat(a, 'session-2.json', { modelConfig: { playwrightBrowser: choice('chrome:Archived') }, archivedAt: '2026-10-01T00:00:00Z' });
    await chat(a, 'session-3.json', { modelConfig: {} });
    await chat(a, 'session-4.json', '{');
    await chat(b, 'session-1.json', { modelConfig: { playwrightBrowser: choice('edge:Other') } });

    const inUse = await browserChoicesInUse(a, undefined);
    expect(inUse.project.map((c) => c.id)).toEqual(['firefox:Chat']);
    expect(inUse.all.map((c) => c.id).sort()).toEqual(['edge:Other', 'firefox:Chat']);
  });

  it('keeps a Windows profile picked from WSL\'s list under its native id too (chat browsers on Windows copy it so)', async () => {
    const inUse = await browserChoicesInUse(path.join(root, 'a'), choice('windows-edge:Default') as never);
    expect(inUse.all.map((c) => c.id)).toEqual(['windows-edge:Default', 'edge:Default']);
    expect(inUse.project.map((c) => c.id)).toEqual(['windows-edge:Default', 'edge:Default']);
  });

  it('chooses nothing for a project without tasks', async () => {
    expect(await browserChoicesInUse(path.join(root, 'a'), undefined)).toEqual({ project: [], all: [] });
  });
});
