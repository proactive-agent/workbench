import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('../../platform/shell-runtime', () => ({ toHostPath: (value: string) => value }));

import { chromiumBookmarksBar, readBookmarksBar } from '../bookmarks';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bookmarks-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const choice = (engine: 'chromium' | 'firefox', extra: Partial<PlaywrightBrowserChoice> = {}): PlaywrightBrowserChoice => ({
  id: `${engine}:x`, browser: engine === 'chromium' ? 'chrome' : 'firefox', engine, profileName: 'x',
  executablePath: '/bin/x', userDataDir: root, profilePath: root, ...extra,
});

describe('bookmarks bar', () => {
  it("reads a Chromium profile's bar with its folders, leaving out what the drawer can't open", () => {
    const text = JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [
            { type: 'url', name: 'Docs', url: 'https://docs.example.com' },
            { type: 'url', name: 'Bookmarklet', url: 'javascript:alert(1)' },
            { type: 'folder', name: 'Work', children: [{ type: 'url', name: '', url: 'http://localhost:3000' }] },
          ],
        },
        other: { children: [{ type: 'url', name: 'Elsewhere', url: 'https://x.com' }] },
      },
    });
    expect(chromiumBookmarksBar(text)).toEqual([
      { title: 'Docs', url: 'https://docs.example.com' },
      { title: 'Work', children: [{ title: 'http://localhost:3000', url: 'http://localhost:3000' }] },
    ]);
  });

  it("reads Firefox's bookmarks toolbar from places.sqlite", async () => {
    const db = new DatabaseSync(path.join(root, 'places.sqlite'));
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT);
      INSERT INTO moz_places VALUES (1, 'https://b.example.com'), (2, 'https://a.example.com'), (3, 'place:sort=8'), (4, 'https://menu.example.com');
      INSERT INTO moz_bookmarks VALUES
        (1, 2, NULL, 0, 0, '', 'root________'),
        (2, 2, NULL, 1, 0, 'menu', 'menu________'),
        (3, 2, NULL, 1, 1, 'toolbar', 'toolbar_____'),
        (4, 1, 1, 3, 1, 'B', 'b'),
        (5, 1, 2, 3, 0, 'A', 'a'),
        (6, 1, 3, 3, 2, 'Most Visited', 'mv'),
        (7, 2, NULL, 3, 3, 'Folder', 'f'),
        (8, 1, 4, 7, 0, NULL, 'm'),
        (9, 1, 4, 2, 0, 'In the menu', 'n');
    `);
    db.close();
    expect(await readBookmarksBar(choice('firefox'))).toEqual([
      { title: 'A', url: 'https://a.example.com' },
      { title: 'B', url: 'https://b.example.com' },
      { title: 'Folder', children: [{ title: 'https://menu.example.com', url: 'https://menu.example.com' }] },
    ]);
  });

  it('reads a profile again only after its bookmarks changed', async () => {
    const file = path.join(root, 'Bookmarks');
    const write = (name: string) =>
      writeFileSync(file, JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name, url: 'https://e.com' }] } } }));
    write('First');
    expect((await readBookmarksBar(choice('chromium')))[0].title).toBe('First');
    write('Second, longer');
    expect((await readBookmarksBar(choice('chromium')))[0].title).toBe('Second, longer');
  });

  it("has nothing for Playwright's own browsers or a profile without bookmarks", async () => {
    expect(await readBookmarksBar(null)).toEqual([]);
    expect(await readBookmarksBar(choice('chromium', { managed: true }))).toEqual([]);
    expect(await readBookmarksBar(choice('chromium'))).toEqual([]);
  });
});
