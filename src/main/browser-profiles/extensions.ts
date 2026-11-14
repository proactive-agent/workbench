/**
 * The extensions of a chat browser's profile copy, which the browser drawer lists next to its
 * address bar (the browsers are headless: their own toolbar never shows), with a switch for each.
 *
 * Firefox: read from the copy's files (`extensions.json`, the toolbar layout in `prefs.js`, icons
 * from each extension's XPI). Playwright's Firefox can't reach the add-on manager while it runs,
 * so a switch is written to `extensions.json` before the browser starts (applyFirefoxExtensionSwitches)
 * and takes effect when it starts again.
 *
 * Chromium: asked of the running browser in its `chrome://extensions` page (chromiumExtensionsCode,
 * run by the chat browser's Playwright server), whose `chrome.developerPrivate` lists them, pinned
 * ones too, and whose `chrome.management` switches them at once. The page opens in the background
 * and closes again; the drawer's bridge never lists it (EXTENSIONS_HELPER_MARK).
 */

import path from 'path';
import { inflateRawSync } from 'zlib';
import { open, readFile, writeFile } from 'fs/promises';
import type { BrowserExtension } from '../../shared/types/browser-drawer';

/** What a switch map holds: extension id -> on (unset: as the profile has it) */
export type ExtensionSwitches = Readonly<Record<string, boolean>>;

/** The address of the Chromium helper page ends with this, so the drawer's bridge never lists it */
export const EXTENSIONS_HELPER_MARK = '#workbench-extensions';

/** Icons larger than this are left out (an extension's toolbar icon is a few kilobytes) */
const MAX_ICON_BYTES = 256 * 1024;
/** The icon size drawn in the drawer's toolbar (device pixels at 2x) */
const ICON_SIZE = 32;

const ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// =============================================================================
// Firefox
// =============================================================================

interface FirefoxAddon {
  id?: string;
  type?: string;
  location?: string;
  active?: boolean;
  userDisabled?: boolean;
  appDisabled?: boolean;
  hidden?: boolean;
  defaultLocale?: { name?: string };
  icons?: Record<string, string>;
}

/** Firefox's toolbar button id for an extension's action (ExtensionCommon's makeWidgetId) */
function widgetId(id: string): string {
  return `${id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}-browser-action`;
}

/** The value of a string pref in prefs.js text */
function stringPref(prefs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`user_pref\\("${escaped}",\\s*"((?:[^"\\\\]|\\\\.)*)"\\);`).exec(prefs);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * The toolbar buttons pinned in Firefox (every toolbar but the extensions panel), in their order:
 * `browser.uiCustomization.state`'s placements
 */
export function firefoxPinnedWidgets(prefs: string): string[] {
  const state = stringPref(prefs, 'browser.uiCustomization.state');
  if (!state) return [];
  try {
    const placements = (JSON.parse(state) as { placements?: Record<string, unknown> }).placements ?? {};
    return Object.entries(placements)
      .filter(([area, widgets]) => area !== 'unified-extensions-area' && area !== 'widget-overflow-fixed-list' && Array.isArray(widgets))
      .flatMap(([, widgets]) => (widgets as unknown[]).filter((widget): widget is string => typeof widget === 'string'));
  } catch {
    return [];
  }
}

/** The icon file to show: the smallest at least ICON_SIZE, else the largest */
function pickIcon(icons: Record<string, string> | undefined): string | undefined {
  const sizes = Object.entries(icons ?? {})
    .map(([size, file]) => ({ size: Number(size), file }))
    .filter((icon) => Number.isFinite(icon.size) && typeof icon.file === 'string' && icon.file)
    .sort((a, b) => a.size - b.size);
  return (sizes.find((icon) => icon.size >= ICON_SIZE) ?? sizes.at(-1))?.file;
}

/** A data: URL of icon bytes, by the file's extension */
function iconUrl(file: string, bytes: Buffer | null): string | undefined {
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!type || !bytes || bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return undefined;
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/**
 * One file of a zip archive (an XPI), or null. Reads only the archive's directory and that file:
 * XPIs can be tens of megabytes
 */
export async function readZipEntry(file: string, name: string): Promise<Buffer | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    // The end of central directory record: in the last 22 bytes plus a comment of up to 64 KB
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const entries = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (directoryOffset + directorySize > size) return null;
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const wanted = name.replace(/^\/+/, '');
    let at = 0;
    for (let i = 0; i < entries && at + 46 <= directory.length; i++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) return null;
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const localOffset = directory.readUInt32LE(at + 42);
      const entryName = directory.toString('utf-8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (entryName !== wanted) continue;
      if (compressedSize > MAX_ICON_BYTES * 4) return null;
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) return null;
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compressedSize);
      await handle.read(data, 0, compressedSize, dataOffset);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** An extension's icon file: from its XPI, or its unpacked folder */
async function firefoxIcon(profileDir: string, id: string, file: string): Promise<string | undefined> {
  const folder = path.join(profileDir, 'extensions');
  const fromXpi = await readZipEntry(path.join(folder, `${id}.xpi`), file).catch(() => null);
  const bytes = fromXpi ?? (await readFile(path.join(folder, id, ...file.split('/'))).catch(() => null));
  return iconUrl(file, bytes);
}

/** The add-ons a user installed in the profile that are extensions Firefox can run */
function userExtensions(addons: readonly FirefoxAddon[]): Array<FirefoxAddon & { id: string }> {
  return addons.filter((addon): addon is FirefoxAddon & { id: string } =>
    typeof addon.id === 'string' && addon.type === 'extension' && addon.location === 'app-profile' && !addon.hidden && !addon.appDisabled);
}

/** The extensions of a Firefox profile (copy), as it runs them now (`enabled`: active) */
export async function readFirefoxExtensions(profileDir: string): Promise<BrowserExtension[]> {
  const text = await readFile(path.join(profileDir, 'extensions.json'), 'utf-8').catch(() => '');
  if (!text) return [];
  let addons: FirefoxAddon[];
  try {
    addons = (JSON.parse(text) as { addons?: FirefoxAddon[] }).addons ?? [];
  } catch {
    return [];
  }
  const prefs = await readFile(path.join(profileDir, 'prefs.js'), 'utf-8').catch(() => '');
  const pinned = firefoxPinnedWidgets(prefs);
  const list = await Promise.all(userExtensions(addons).map(async (addon): Promise<BrowserExtension & { order: number }> => {
    const iconFile = pickIcon(addon.icons);
    const icon = iconFile ? await firefoxIcon(profileDir, addon.id, iconFile) : undefined;
    const order = pinned.indexOf(widgetId(addon.id));
    return {
      id: addon.id,
      name: addon.defaultLocale?.name || addon.id,
      enabled: addon.active === true,
      pinned: order >= 0,
      ...(icon ? { icon } : {}),
      order,
    };
  }));
  return orderExtensions(list);
}

/** Where a Firefox extension's toolbar button leads: its popup page, else its homepage */
export interface FirefoxExtensionTarget {
  popupUrl?: string;
  homepageUrl?: string;
}

/**
 * What clicking a Firefox extension opens: its action's popup (`moz-extension://<its uuid>/...`,
 * from its manifest and the profile's `extensions.webextensions.uuids`), or its homepage
 */
export async function firefoxExtensionTarget(profileDir: string, id: string): Promise<FirefoxExtensionTarget> {
  const text = await readFile(path.join(profileDir, 'extensions.json'), 'utf-8').catch(() => '');
  let addon: FirefoxAddon | undefined;
  try {
    addon = userExtensions((JSON.parse(text) as { addons?: FirefoxAddon[] }).addons ?? []).find((a) => a.id === id);
  } catch {
    addon = undefined;
  }
  if (!addon) return {};
  const target: FirefoxExtensionTarget = {};
  // Its homepage: in Firefox's cache of add-ons.mozilla.org's listings (addons.json)
  const listings = await readFile(path.join(profileDir, 'addons.json'), 'utf-8').catch(() => '');
  try {
    const listing = ((JSON.parse(listings || '{}') as { addons?: Array<{ id?: unknown; homepageURL?: unknown }> }).addons ?? [])
      .find((entry) => entry.id === id);
    if (typeof listing?.homepageURL === 'string' && /^https?:\/\//i.test(listing.homepageURL)) target.homepageUrl = listing.homepageURL;
  } catch {
    // No listings
  }

  const folder = path.join(profileDir, 'extensions');
  const manifestBytes = (await readZipEntry(path.join(folder, `${id}.xpi`), 'manifest.json').catch(() => null))
    ?? (await readFile(path.join(folder, id, 'manifest.json')).catch(() => null));
  let manifest: { action?: { default_popup?: unknown }; browser_action?: { default_popup?: unknown }; homepage_url?: unknown } = {};
  try {
    manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf-8').replace(/^\uFEFF/, '')) : {};
  } catch {
    manifest = {};
  }
  if (!target.homepageUrl && typeof manifest.homepage_url === 'string' && /^https?:\/\//i.test(manifest.homepage_url)) {
    target.homepageUrl = manifest.homepage_url;
  }
  const popup = (manifest.action ?? manifest.browser_action)?.default_popup;
  const prefs = await readFile(path.join(profileDir, 'prefs.js'), 'utf-8').catch(() => '');
  let uuid: unknown;
  try {
    uuid = (JSON.parse(stringPref(prefs, 'extensions.webextensions.uuids') ?? '{}') as Record<string, unknown>)[id];
  } catch {
    uuid = undefined;
  }
  if (typeof popup === 'string' && popup && typeof uuid === 'string' && /^[0-9a-f-]{36}$/i.test(uuid)) {
    target.popupUrl = `moz-extension://${uuid}/${popup.replace(/^\/+/, '')}`;
  }
  return target;
}

/**
 * Write the switches into a Firefox profile copy's `extensions.json`, before the browser starts
 * (it reads them at start). Only the extensions a switch names change. Whether anything changed
 */
export async function applyFirefoxExtensionSwitches(profileDir: string, switches: ExtensionSwitches): Promise<boolean> {
  if (Object.keys(switches).length === 0) return false;
  const file = path.join(profileDir, 'extensions.json');
  const text = await readFile(file, 'utf-8').catch(() => '');
  if (!text) return false;
  const data = JSON.parse(text) as { addons?: FirefoxAddon[] };
  let changed = false;
  for (const addon of userExtensions(data.addons ?? [])) {
    const on = switches[addon.id];
    if (on === undefined || (addon.userDisabled === !on && addon.active === on)) continue;
    addon.userDisabled = !on;
    addon.active = on;
    changed = true;
  }
  if (changed) await writeFile(file, JSON.stringify(data), { mode: 0o600 });
  return changed;
}

// =============================================================================
// Chromium
// =============================================================================

/**
 * Playwright code (for the server's `browser_run_code_unsafe`, given the current page) that opens
 * the extensions page in the background, switches the extensions `switches` names, and returns
 * the list. Everything that waits does so in the page (the server's code sandbox has no timers
 * worth relying on), each step bounded, and the page always closes again
 */
export function chromiumExtensionsCode(switches: ExtensionSwitches): string {
  const helperUrl = `chrome://extensions/${EXTENSIONS_HELPER_MARK}`;
  return `async (page) => {
  const context = page.context();
  const cdp = await context.newCDPSession(page);
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes(${JSON.stringify(EXTENSIONS_HELPER_MARK)}), timeout: 10000 });
  try {
    await cdp.send('Target.createTarget', { url: ${JSON.stringify(helperUrl)}, background: true });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const helper = await opened;
  try {
    await helper.waitForFunction(() => !!(globalThis.chrome && (chrome.developerPrivate || chrome.management)), undefined, { timeout: 10000 });
    return await helper.evaluate(async (switches) => {
      const bounded = (promise) => Promise.race([promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000))]);
      for (const [id, on] of Object.entries(switches)) {
        if (chrome.management) await bounded(chrome.management.setEnabled(id, on));
      }
      if (chrome.developerPrivate) {
        const list = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
        return list.filter((e) => e.type === 'EXTENSION' && e.location !== 'COMPONENT').map((e) => ({
          id: e.id, name: e.name, enabled: e.state === 'ENABLED' || e.state === 'TERMINATED', pinned: e.pinnedToToolbar === true, icon: e.iconUrl,
        }));
      }
      const list = await chrome.management.getAll();
      return list.filter((e) => e.type === 'extension' && e.installType !== 'other').map((e) => ({
        id: e.id, name: e.name, enabled: e.enabled, pinned: false, icon: (e.icons || []).slice(-1)[0]?.url,
      }));
    }, ${JSON.stringify(switches)});
  } finally {
    await helper.close().catch(() => undefined);
  }
}`;
}

/** The list a run of chromiumExtensionsCode returned, from the tool's reply text (its `### Result` section) */
export function parseChromiumExtensions(text: string): BrowserExtension[] {
  const match = /### Result\s*\n([\s\S]*?)(?:\n### |$)/.exec(text);
  if (!match) throw new Error('The browser did not list its extensions');
  const raw = JSON.parse(match[1].trim()) as unknown;
  if (!Array.isArray(raw)) return [];
  const list = raw.flatMap((item): Array<BrowserExtension & { order: number }> => {
    if (!item || typeof item !== 'object') return [];
    const { id, name, enabled, pinned, icon } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return [];
    const image = typeof icon === 'string' && icon.startsWith('data:image/') && icon.length <= MAX_ICON_BYTES * 2 ? icon : undefined;
    return [{
      id,
      name: typeof name === 'string' && name ? name : id,
      enabled: enabled === true,
      pinned: pinned === true,
      ...(image ? { icon: image } : {}),
      order: pinned === true ? 0 : -1,
    }];
  });
  return orderExtensions(list);
}

/** Pinned ones first, in their toolbar order, then the others by name */
function orderExtensions(list: Array<BrowserExtension & { order: number }>): BrowserExtension[] {
  return list
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    })
    .map(({ order: _order, ...extension }) => extension);
}
