import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseChromiumLocalState, parseFirefoxProfilesIni } from '../parsing';

describe('parseChromiumLocalState', () => {
  it("lists profiles in the browser's order with their names and accounts", () => {
    const localState = JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Person 1', user_name: '' },
          'Profile 2': { name: 'Work', user_name: 'me@work.example' },
          'Profile 1': { name: 'Home' },
        },
        profiles_order: ['Profile 2', 'Default', 'Gone'],
      },
    });
    expect(parseChromiumLocalState(localState)).toEqual([
      { directory: 'Profile 2', name: 'Work', email: 'me@work.example' },
      { directory: 'Default', name: 'Person 1' },
      { directory: 'Profile 1', name: 'Home' },
    ]);
  });

  it('sorts by folder without an order and names unnamed profiles after their folder', () => {
    const localState = JSON.stringify({ profile: { info_cache: { 'Profile 1': {}, Default: { name: '  ' } } } });
    expect(parseChromiumLocalState(localState)).toEqual([
      { directory: 'Default', name: 'Default' },
      { directory: 'Profile 1', name: 'Profile 1' },
    ]);
  });

  it('gives no profiles for invalid JSON or a missing info_cache', () => {
    expect(parseChromiumLocalState('{not json')).toEqual([]);
    expect(parseChromiumLocalState('{}')).toEqual([]);
    expect(parseChromiumLocalState('null')).toEqual([]);
    expect(parseChromiumLocalState(JSON.stringify({ profile: { info_cache: [] } }))).toEqual([]);
  });
});

describe('parseFirefoxProfilesIni', () => {
  it('reads Linux profiles, with the install default first', () => {
    const ini = [
      '[Profile1]',
      'Name=default',
      'IsRelative=1',
      'Path=abcd.default',
      'Default=1',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=efgh.default-release',
      '',
      '[Install4F96D1932A9F858E]',
      'Default=efgh.default-release',
      'Locked=1',
      '',
      '[General]',
      'StartWithLastProfile=1',
      'Version=2',
    ].join('\n');
    expect(parseFirefoxProfilesIni(ini, '/home/me/.mozilla/firefox', path.posix)).toEqual([
      { name: 'default-release', path: '/home/me/.mozilla/firefox/efgh.default-release', folder: 'efgh.default-release', isDefault: true },
      { name: 'default', path: '/home/me/.mozilla/firefox/abcd.default', folder: 'abcd.default', isDefault: false },
    ]);
  });

  it('reads Windows profiles with CRLF, comments, relative and absolute paths', () => {
    const ini = [
      '\uFEFF; written by Firefox',
      '[Profile0]',
      'Name=Main',
      'IsRelative=1',
      'Path=Profiles/xyz.default-release',
      'Default=1',
      '',
      '[Profile1]',
      'Name=Elsewhere',
      'IsRelative=0',
      'Path=D:\\Firefox\\other',
      '',
      '[Profile2]',
      'Name=No path',
    ].join('\r\n');
    const appData = 'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox';
    expect(parseFirefoxProfilesIni(ini, appData, path.win32)).toEqual([
      { name: 'Main', path: `${appData}\\Profiles\\xyz.default-release`, folder: 'xyz.default-release', isDefault: true },
      { name: 'Elsewhere', path: 'D:\\Firefox\\other', folder: 'other', isDefault: false },
    ]);
  });

  it('reads macOS profiles and names unnamed ones after their folder', () => {
    const ini = '[Profile0]\nIsRelative=1\nPath=Profiles/q1.default\n';
    const dir = '/Users/me/Library/Application Support/Firefox';
    expect(parseFirefoxProfilesIni(ini, dir, path.posix)).toEqual([
      { name: 'q1.default', path: `${dir}/Profiles/q1.default`, folder: 'q1.default', isDefault: false },
    ]);
  });

  it('gives no profiles for an empty file', () => {
    expect(parseFirefoxProfilesIni('', '/x', path.posix)).toEqual([]);
  });
});
