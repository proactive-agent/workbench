import os from 'os';
import path from 'path';
import { deflateRawSync } from 'zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFirefoxExtensionSwitches,
  chromiumExtensionsCode,
  EXTENSIONS_HELPER_MARK,
  firefoxExtensionTarget,
  firefoxPinnedWidgets,
  parseChromiumExtensions,
  readFirefoxExtensions,
  readZipEntry,
} from '../extensions';

/** A zip archive of the files (deflated, but stored when `stored` names them) */
function zip(files: Record<string, Buffer>, stored: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const method = stored.includes(name) ? 0 : 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const uiState = (placements: Record<string, string[]>) =>
  `user_pref("browser.uiCustomization.state", ${JSON.stringify(JSON.stringify({ placements, currentVersion: 26 }))});\n`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-extensions-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('zip entries', () => {
  it('reads a deflated or stored file of an archive, and nothing for a missing one or a non-archive', async () => {
    const file = path.join(dir, 'a.xpi');
    const big = Buffer.alloc(100_000, 'x');
    await writeFile(file, zip({ 'manifest.json': Buffer.from('{}'), 'icons/a.png': Buffer.from('PNG!'), 'big.js': big }, ['icons/a.png']));
    expect((await readZipEntry(file, 'icons/a.png'))?.toString()).toBe('PNG!');
    expect((await readZipEntry(file, '/manifest.json'))?.toString()).toBe('{}');
    expect(await readZipEntry(file, 'icons/b.png')).toBeNull();
    await writeFile(path.join(dir, 'not.xpi'), 'not a zip');
    expect(await readZipEntry(path.join(dir, 'not.xpi'), 'a')).toBeNull();
  });
});

describe('Firefox extensions', () => {
  const addon = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'extension', location: 'app-profile', active: true, userDisabled: false, appDisabled: false, hidden: false,
    defaultLocale: { name }, icons: { '16': 'icons/16.png', '48': 'icons/48.svg', '128': 'icons/128.png' }, ...extra,
  });

  beforeEach(async () => {
    await writeFile(path.join(dir, 'extensions.json'), JSON.stringify({
      schemaVersion: 36,
      addons: [
        addon('uBlock0@raymondhill.net', 'uBlock Origin'),
        addon('addon@darkreader.org', 'Dark Reader', { icons: { '48': 'dr.png' } }),
        addon('{d8b32864-153d}', 'A disabled one', { active: false, userDisabled: true, icons: {} }),
        addon('newtab@mozilla.org', 'New Tab', { hidden: true }),
        addon('old@example.com', 'Unsigned', { active: false, appDisabled: true }),
        addon('system@mozilla.org', 'System', { location: 'app-system-defaults' }),
        addon('theme@example.com', 'A theme', { type: 'theme' }),
      ],
    }));
    await mkdir(path.join(dir, 'extensions', 'addon@darkreader.org'), { recursive: true });
    await writeFile(path.join(dir, 'extensions', 'addon@darkreader.org', 'dr.png'), 'DR');
    await writeFile(path.join(dir, 'extensions', 'uBlock0@raymondhill.net.xpi'), zip({ 'icons/48.svg': Buffer.from('<svg/>') }));
    await writeFile(path.join(dir, 'prefs.js'), uiState({
      'nav-bar': ['back-button', 'urlbar-container', 'addon_darkreader_org-browser-action'],
      'unified-extensions-area': ['ublock0_raymondhill_net-browser-action'],
    }));
  });

  it("lists the user's extensions, pinned ones first, with their icons from the XPI or the folder", async () => {
    expect(await readFirefoxExtensions(dir)).toEqual([
      { id: 'addon@darkreader.org', name: 'Dark Reader', enabled: true, pinned: true, icon: `data:image/png;base64,${Buffer.from('DR').toString('base64')}` },
      { id: '{d8b32864-153d}', name: 'A disabled one', enabled: false, pinned: false },
      { id: 'uBlock0@raymondhill.net', name: 'uBlock Origin', enabled: true, pinned: false, icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` },
    ]);
  });

  it('pins the toolbar buttons placed outside the extensions panel', () => {
    expect(firefoxPinnedWidgets(uiState({ 'nav-bar': ['a'], TabsToolbar: ['b'], 'unified-extensions-area': ['c'], 'widget-overflow-fixed-list': ['d'] }))).toEqual(['a', 'b']);
    expect(firefoxPinnedWidgets('')).toEqual([]);
  });

  it("opens an extension's popup page, else its homepage", async () => {
    await writeFile(path.join(dir, 'extensions', 'uBlock0@raymondhill.net.xpi'), zip({
      'manifest.json': Buffer.from(JSON.stringify({ browser_action: { default_popup: '/popup-fenix.html' } })),
    }));
    await writeFile(path.join(dir, 'extensions', 'addon@darkreader.org', 'manifest.json'), JSON.stringify({ homepage_url: 'https://darkreader.org/' }));
    await writeFile(path.join(dir, 'addons.json'), JSON.stringify({ addons: [{ id: 'uBlock0@raymondhill.net', homepageURL: 'https://github.com/gorhill/uBlock' }] }));
    const uuid = '70c47c55-d3db-4583-9077-fb1ea866f41e';
    await writeFile(path.join(dir, 'prefs.js'), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'uBlock0@raymondhill.net': uuid }))});\n`);
    expect(await firefoxExtensionTarget(dir, 'uBlock0@raymondhill.net')).toEqual({
      popupUrl: `moz-extension://${uuid}/popup-fenix.html`,
      homepageUrl: 'https://github.com/gorhill/uBlock',
    });
    expect(await firefoxExtensionTarget(dir, 'addon@darkreader.org')).toEqual({ homepageUrl: 'https://darkreader.org/' });
    expect(await firefoxExtensionTarget(dir, 'newtab@mozilla.org')).toEqual({});
  });

  it('writes the switches for the next start, only for the extensions they name', async () => {
    expect(await applyFirefoxExtensionSwitches(dir, { 'uBlock0@raymondhill.net': false, '{d8b32864-153d}': true, 'old@example.com': true })).toBe(true);
    const addons = JSON.parse(await readFile(path.join(dir, 'extensions.json'), 'utf-8')).addons as Array<Record<string, unknown>>;
    const state = (id: string) => addons.find((a) => a.id === id);
    expect(state('uBlock0@raymondhill.net')).toMatchObject({ active: false, userDisabled: true });
    expect(state('{d8b32864-153d}')).toMatchObject({ active: true, userDisabled: false });
    expect(state('addon@darkreader.org')).toMatchObject({ active: true, userDisabled: false });
    // Firefox can't run it: left as it is
    expect(state('old@example.com')).toMatchObject({ active: false, appDisabled: true });
    expect(await applyFirefoxExtensionSwitches(dir, { 'uBlock0@raymondhill.net': false })).toBe(false);
    expect(await applyFirefoxExtensionSwitches(path.join(dir, 'missing'), { a: true })).toBe(false);
  });
});

describe('Chromium extensions', () => {
  it('opens its marked helper page and switches the extensions named', () => {
    const code = chromiumExtensionsCode({ abc: false });
    expect(code).toContain(`chrome://extensions/${EXTENSIONS_HELPER_MARK}`);
    expect(code).toContain('{"abc":false}');
    expect(code).toContain('helper.close()');
  });

  it('reads the list from the tool reply, pinned ones first, keeping image icons only', () => {
    const reply = [
      '### Result',
      JSON.stringify([
        { id: 'b', name: 'Bitwarden', enabled: true, pinned: false, icon: 'data:image/png;base64,AA==' },
        { id: 'a', name: 'AdBlock', enabled: false, pinned: false, icon: 'chrome://extension-icon/a/32/0' },
        { id: 'z', name: 'Zotero', enabled: true, pinned: true },
        { name: 'No id' },
      ]),
      '### Ran Playwright code',
      '```js',
      'await (async (page) => {})(page);',
      '```',
    ].join('\n');
    expect(parseChromiumExtensions(reply)).toEqual([
      { id: 'z', name: 'Zotero', enabled: true, pinned: true },
      { id: 'a', name: 'AdBlock', enabled: false, pinned: false },
      { id: 'b', name: 'Bitwarden', enabled: true, pinned: false, icon: 'data:image/png;base64,AA==' },
    ]);
    expect(() => parseChromiumExtensions('### Error\nno')).toThrow();
  });
});
