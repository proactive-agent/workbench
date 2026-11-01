/**
 * Reading browsers' profile lists: Chromium's `Local State` (profile.info_cache) and Firefox's
 * profiles.ini. Pure; unreadable input gives no profiles.
 */

import path from 'path';

type PathApi = typeof path.posix;

export interface ChromiumProfileEntry {
  /** The profile's folder inside the user data folder (`Default`, `Profile 1`) */
  directory: string;
  name: string;
  email?: string;
}

/** Profiles in a Chromium `Local State` file, in the browser's own order */
export function parseChromiumLocalState(json: string): ChromiumProfileEntry[] {
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    return [];
  }
  const profile = (state as { profile?: { info_cache?: unknown; profiles_order?: unknown } } | null)?.profile;
  const cache = profile?.info_cache;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return [];
  const entries = cache as Record<string, { name?: unknown; user_name?: unknown } | null>;
  const order = Array.isArray(profile.profiles_order)
    ? profile.profiles_order.filter((dir): dir is string => typeof dir === 'string' && dir in entries)
    : [];
  const rest = Object.keys(entries).filter((dir) => !order.includes(dir)).sort((a, b) => a.localeCompare(b));
  return [...order, ...rest].map((directory) => {
    const info = entries[directory] ?? {};
    const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : directory;
    const email = typeof info.user_name === 'string' && info.user_name.trim() ? info.user_name.trim() : undefined;
    return { directory, name, ...(email ? { email } : {}) };
  });
}

export interface FirefoxProfileEntry {
  name: string;
  /** The profile's folder */
  path: string;
  /** The folder's own name, which tells profiles apart */
  folder: string;
  /** The profile Firefox opens by default */
  isDefault: boolean;
}

/** INI sections: name -> key/value pairs */
function parseIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1].trim(), current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

/**
 * Profiles in a Firefox profiles.ini. Relative paths (always written with `/`) are resolved
 * against `iniDir` with `pathApi` (the paths of the OS the file belongs to)
 */
export function parseFirefoxProfilesIni(text: string, iniDir: string, pathApi: PathApi = path): FirefoxProfileEntry[] {
  const sections = parseIni(text);
  // Newer Firefox records each install's default in an [Install<hash>] section
  const installDefaults = new Set(
    [...sections].filter(([name]) => name.startsWith('Install')).map(([, values]) => values.Default).filter(Boolean)
  );
  const profiles: FirefoxProfileEntry[] = [];
  for (const [name, values] of sections) {
    if (!/^Profile\d+$/.test(name) || !values.Path) continue;
    const relative = values.IsRelative !== '0';
    const profilePath = relative ? pathApi.join(iniDir, ...values.Path.split('/')) : values.Path;
    const folder = pathApi.basename(profilePath);
    profiles.push({
      name: values.Name || folder,
      path: profilePath,
      folder,
      isDefault: installDefaults.size > 0 ? installDefaults.has(values.Path) : values.Default === '1',
    });
  }
  return profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}
