/**
 * Last results of the checks behind settings' refresh buttons (CLI version, branches, Ollama...),
 * kept in localStorage. Pages show these when opened and only fetch on their refresh button, or
 * the first time when nothing was fetched before, so opening a page never triggers a slow check.
 */

const PREFIX = 'refresh-cache:';

export function readRefreshCache<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeRefreshCache<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full: the page just fetches again next time
  }
}
