/**
 * The bookmarks bar of a browser profile, which the browser drawer shows under its address bar:
 * the drawer's browsers run headless, so their own toolbars never show.
 *
 * Read from the user's profile itself (not the run's copy), so bookmarks added in the browser show
 * up: Chromium browsers keep them in the profile's `Bookmarks` JSON file, Firefox in
 * `places.sqlite`, which a running Firefox keeps locked, so a copy of it (and its write-ahead log)
 * is read instead.
 */

import os from 'os';
import path from 'path';
import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import type { BrowserBookmark } from '../../shared/types/browser-drawer';
import { toHostPath } from '../platform/shell-runtime';

/** At most this many bookmarks and folders are read (a bar never shows more) */
const MAX_ITEMS = 2000;

/** Addresses the drawer opens (as its address bar does): not bookmarklets or browser pages */
const opensInDrawer = (url: string) => /^(https?|about|file):/i.test(url);

interface ChromiumNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromiumNode[];
}

/** Chromium's `Bookmarks` file: the bookmarks bar's items */
export function chromiumBookmarksBar(text: string): BrowserBookmark[] {
  const data = JSON.parse(text) as { roots?: { bookmark_bar?: ChromiumNode } };
  let left = MAX_ITEMS;
  const convert = (nodes: ChromiumNode[] | undefined): BrowserBookmark[] => {
    const items: BrowserBookmark[] = [];
    for (const node of nodes ?? []) {
      if (left-- <= 0) break;
      if (node.type === 'url' && node.url && opensInDrawer(node.url)) items.push({ title: node.name || node.url, url: node.url });
      else if (node.type === 'folder') items.push({ title: node.name ?? '', children: convert(node.children) });
    }
    return items;
  };
  return convert(data.roots?.bookmark_bar?.children);
}

interface FirefoxBookmarkRow {
  id: number;
  parent: number;
  /** 1 bookmark, 2 folder, 3 separator */
  type: number;
  title: string | null;
  url: string | null;
  guid: string;
}

/** Firefox's bookmarks (moz_bookmarks rows in position order): the bookmarks toolbar's items */
function firefoxBookmarksBar(rows: readonly FirefoxBookmarkRow[]): BrowserBookmark[] {
  const toolbar = rows.find((row) => row.guid === 'toolbar_____');
  if (!toolbar) return [];
  const byParent = new Map<number, FirefoxBookmarkRow[]>();
  for (const row of rows) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row]);
  let left = MAX_ITEMS;
  const convert = (parent: number, depth: number): BrowserBookmark[] => {
    const items: BrowserBookmark[] = [];
    for (const row of byParent.get(parent) ?? []) {
      if (left-- <= 0) break;
      // place: URLs are saved searches (Most Visited...), which only Firefox can run
      if (row.type === 1 && row.url && opensInDrawer(row.url)) items.push({ title: row.title || row.url, url: row.url });
      else if (row.type === 2 && depth < 32) items.push({ title: row.title ?? '', children: convert(row.id, depth + 1) });
    }
    return items;
  };
  return convert(toolbar.id, 0);
}

async function readFirefoxBookmarks(profileDir: string): Promise<BrowserBookmark[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-bookmarks-'));
  try {
    const copy = path.join(dir, 'places.sqlite');
    await copyFile(path.join(profileDir, 'places.sqlite'), copy);
    // Recent changes may still be in the write-ahead log only
    await copyFile(path.join(profileDir, 'places.sqlite-wal'), `${copy}-wal`).catch(() => undefined);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(copy);
    try {
      const rows = db.prepare(
        `SELECT b.id AS id, b.parent AS parent, b.type AS type, b.title AS title, p.url AS url, b.guid AS guid
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
         ORDER BY b.parent, b.position`
      ).all() as unknown as FirefoxBookmarkRow[];
      return firefoxBookmarksBar(rows);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The file whose changes change a profile's bookmarks */
function bookmarksFile(choice: PlaywrightBrowserChoice): string | undefined {
  if (choice.managed || !choice.profilePath) return undefined;
  const dir = toHostPath(choice.profilePath);
  if (choice.engine === 'chromium') return path.join(dir, 'Bookmarks');
  if (choice.engine === 'firefox') return path.join(dir, 'places.sqlite');
  return undefined;
}

const cache = new Map<string, { version: string; bookmarks: BrowserBookmark[] }>();

/** A profile's bookmarks bar (empty without one: Playwright's own browsers, a profile without bookmarks) */
export async function readBookmarksBar(choice: PlaywrightBrowserChoice | null | undefined): Promise<BrowserBookmark[]> {
  const file = choice ? bookmarksFile(choice) : undefined;
  if (!choice || !file) return [];
  // Read again only after the profile's bookmarks file (or Firefox's log) changed
  const stamps = await Promise.all([file, `${file}-wal`].map((f) => stat(f).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')));
  const version = stamps.join('|');
  const cached = cache.get(file);
  if (cached?.version === version) return cached.bookmarks;
  let bookmarks: BrowserBookmark[] = [];
  if (stamps[0] !== '-') {
    bookmarks = choice.engine === 'firefox'
      ? await readFirefoxBookmarks(path.dirname(file))
      : chromiumBookmarksBar(await readFile(file, 'utf-8'));
  }
  cache.set(file, { version, bookmarks });
  return bookmarks;
}
