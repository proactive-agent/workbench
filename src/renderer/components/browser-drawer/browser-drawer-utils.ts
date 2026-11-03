import type { BrowserDrawerInput, BrowserDrawerSession } from '../../../shared/types/browser-drawer';
import type { BrowserEngine } from '../../../shared/types/browser-profiles';
import { browserProfileIcon } from '../settings/browser-profile-meta';

/** A session's browser icon, as its profile shows in the picker: Playwright's for its own builds, else the engine's */
export function sessionBrowserIcon(session: Pick<BrowserDrawerSession, 'browserName' | 'managed'>): React.ElementType {
  return browserProfileIcon({ engine: session.browserName as BrowserEngine, managed: !!session.managed });
}

/** What the address field's text opens: a URL as typed, else https (http for this machine) */
export function addressToUrl(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (/^(https?|about|file):/i.test(value)) return value;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}

/** A tab's label: the page's title, else its address without the scheme */
export function pageLabel(page: { title: string; url: string }): string {
  return page.title.trim() || page.url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
}

/** A DOM mouse button as Playwright names it */
export function mouseButton(button: number): Extract<BrowserDrawerInput, { kind: 'mousedown' | 'mouseup' }>['button'] {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}

/** Whether a key press pastes (left to the paste event, which sends the text) */
export function isPasteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
}
