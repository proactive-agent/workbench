/**
 * Data saved before the browser connector moved from Puppeteer to Playwright is renamed where it is
 * read: the settings file (every main-process reader) and the chats' MCP menu ids
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));

import { readSettingsFile, readSettingsFileAsync } from '../settings-utils';
import { SessionStorage } from '../insights/session-storage';
import type { InsightsPaths } from '../insights/paths';

describe('connector data from before Playwright', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'connector-migration-'));
    mocks.userData = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the settings file with the connector keys renamed', async () => {
    const browser = { id: 'chrome:Default', browser: 'chrome', engine: 'chromium' };
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({
      theme: 'dark',
      mcpConnectors: { puppeteerEnabled: true, puppeteerBrowser: browser },
    }));

    const expected = { theme: 'dark', mcpConnectors: { playwrightEnabled: true, playwrightBrowser: browser } };
    expect(await readSettingsFileAsync()).toEqual(expected);
    expect(readSettingsFile()).toEqual(expected);
  });

  it("reads a chat's MCP menu with the old connector id renamed", async () => {
    const sessionsDir = path.join(root, 'chats');
    await mkdir(sessionsDir, { recursive: true });
    const session = {
      id: 's1', projectId: 'p1', title: 'Chat', messages: [],
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      modelConfig: { profileId: 'balanced', model: 'sonnet', thinkingLevel: 'medium', mcpConnectors: ['context7', 'puppeteer'] },
    };
    await writeFile(path.join(sessionsDir, 's1.json'), JSON.stringify(session));
    const paths = {
      getSessionsDir: () => sessionsDir,
      getSessionPath: (_project: string, id: string) => path.join(sessionsDir, `${id}.json`),
    } as unknown as InsightsPaths;
    const storage = new SessionStorage(paths);

    expect(storage.loadSessionById('/project', 's1')?.modelConfig?.mcpConnectors).toEqual(['context7', 'playwright']);
    expect(storage.listSessions('/project')[0].modelConfig?.mcpConnectors).toEqual(['context7', 'playwright']);
  });
});
