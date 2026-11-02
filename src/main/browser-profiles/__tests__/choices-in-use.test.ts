/**
 * The profiles still chosen: Settings plus the tasks' own picks that aren't archived, per project
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

  it("lists Settings' choice and the tasks' own picks, leaving out archived tasks and Puppeteer's Chrome", async () => {
    const [a, b] = projects.list.map((project) => project.path);
    await task(a, '001-own', { puppeteerBrowser: choice('chrome:A') });
    await task(a, '002-archived', { puppeteerBrowser: choice('chrome:Old'), archivedAt: '2026-10-01T00:00:00Z' });
    await task(a, '003-default-chrome', { puppeteerBrowser: null });
    await task(a, '004-follows-settings', {});
    await task(b, '001-other', { puppeteerBrowser: choice('chrome:B') });
    await mkdir(path.join(a, '.workbench', 'tasks', '005-broken'), { recursive: true });
    await writeFile(path.join(a, '.workbench', 'tasks', '005-broken', 'task_metadata.json'), '{');

    const inUse = await browserChoicesInUse(a, choice('chrome:Settings') as never);
    expect(inUse.project.map((c) => c.id)).toEqual(['chrome:Settings', 'chrome:A']);
    expect(inUse.all.map((c) => c.id).sort()).toEqual(['chrome:A', 'chrome:B', 'chrome:Settings']);
  });

  it('chooses nothing for a project without tasks', async () => {
    expect(await browserChoicesInUse(path.join(root, 'a'), undefined)).toEqual({ project: [], all: [] });
  });
});
