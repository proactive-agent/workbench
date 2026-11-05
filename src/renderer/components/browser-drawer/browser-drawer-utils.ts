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

/**
 * The page's viewport length for `length` CSS pixels of drawer: the largest one up to it that is a
 * whole, even number of device pixels at `scale` (frames are an even number of pixels wide and
 * high). At a fractional devicePixelRatio (1.25, 1.5) other lengths make the browser and the
 * canvas resample the frame, which blurs all text; at most a few pixels are left unused. A scale
 * without such a length nearby keeps the whole length
 */
export function alignedViewportLength(length: number, scale: number): number {
  const whole = Math.floor(length);
  if (!(scale > 0)) return whole;
  for (let candidate = whole; candidate > 0 && candidate > whole - 32; candidate--) {
    const device = candidate * scale;
    const rounded = Math.round(device);
    if (Math.abs(device - rounded) < 1e-6 && rounded % 2 === 0) return candidate;
  }
  return whole;
}

/**
 * How far (CSS pixels) to move something at `position` so it starts on a device pixel: a canvas
 * between device pixels is resampled when drawn, blurring the page it shows
 */
export function devicePixelOffset(position: number, scale: number): number {
  if (!(scale > 0)) return 0;
  const device = position * scale;
  const offset = (Math.round(device) - device) / scale;
  return Math.abs(offset) < 1e-6 ? 0 : offset;
}
