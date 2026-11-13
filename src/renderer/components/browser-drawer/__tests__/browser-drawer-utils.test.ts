import { describe, it, expect } from 'vitest';
import { addressToUrl, alignedViewportLength, devicePixelOffset, isCopyShortcut, isPasteShortcut, mouseButton, pageLabel, pageCursor } from '../browser-drawer-utils';

describe('browser drawer helpers', () => {
  it('turns the address field into a URL', () => {
    expect(addressToUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(addressToUrl('example.com')).toBe('https://example.com');
    expect(addressToUrl('localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(addressToUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(addressToUrl('about:blank')).toBe('about:blank');
    expect(addressToUrl('   ')).toBeNull();
  });

  it('labels a tab by its title, else its address', () => {
    expect(pageLabel({ title: 'Docs', url: 'https://x.test/' })).toBe('Docs');
    expect(pageLabel({ title: ' ', url: 'https://x.test/' })).toBe('x.test');
  });

  it('maps mouse buttons and the paste shortcut', () => {
    expect([0, 1, 2].map(mouseButton)).toEqual(['left', 'middle', 'right']);
    expect(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isPasteShortcut({ key: 'V', ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isPasteShortcut({ key: 'v', ctrlKey: false, metaKey: false }, false)).toBe(false);
    // Each platform's own modifier only
    expect(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(isPasteShortcut({ key: 'v', ctrlKey: false, metaKey: true }, false)).toBe(false);
  });
});

describe('alignedViewportLength', () => {
  it('keeps lengths that are an even number of device pixels', () => {
    expect(alignedViewportLength(700, 1)).toBe(700);
    expect(alignedViewportLength(701, 2)).toBe(701);
    expect(alignedViewportLength(1000, 1.25)).toBe(1000);
  });

  it('shortens the others to the nearest that is', () => {
    expect(alignedViewportLength(701, 1)).toBe(700);
    expect(alignedViewportLength(703.6, 1.5)).toBe(700);
    expect(alignedViewportLength(1007, 1.25)).toBe(1000);
  });

  it('keeps the length when no scale fits nearby', () => {
    expect(alignedViewportLength(701, 1.33)).toBe(701);
    expect(alignedViewportLength(701, 0)).toBe(701);
  });
});

describe('devicePixelOffset', () => {
  it('moves a position between device pixels onto one', () => {
    expect(devicePixelOffset(1, 1.5) * 1.5 + 1.5).toBeCloseTo(2);
    expect(devicePixelOffset(10, 1.25) * 1.25 + 12.5).toBeCloseTo(13);
  });

  it('leaves positions on device pixels', () => {
    expect(devicePixelOffset(2, 1.5)).toBe(0);
    expect(devicePixelOffset(7, 1)).toBe(0);
  });
});

describe('isCopyShortcut', () => {
  const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it("takes the platform's shortcut modifier with C or X, not other keys or chords", () => {
    expect(isCopyShortcut(press('c', { ctrlKey: true }), false)).toBe(true);
    expect(isCopyShortcut(press('X', { metaKey: true }), true)).toBe(true);
    expect(isCopyShortcut(press('c', {}), false)).toBe(false);
    expect(isCopyShortcut(press('v', { ctrlKey: true }), false)).toBe(false);
    // Ctrl+Shift+C opens a browser's inspector; Alt chords are something else
    expect(isCopyShortcut(press('C', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isCopyShortcut(press('c', { ctrlKey: true, altKey: true }), false)).toBe(false);
    // On macOS Ctrl+C isn't copy (a web terminal's interrupt), and Cmd+C isn't copy elsewhere
    expect(isCopyShortcut(press('c', { ctrlKey: true }), true)).toBe(false);
    expect(isCopyShortcut(press('c', { metaKey: true }), false)).toBe(false);
  });
});

describe('pageCursor', () => {
  it("keeps CSS's cursor keywords and shows the arrow for anything else", () => {
    expect(pageCursor('pointer')).toBe('pointer');
    expect(pageCursor('text')).toBe('text');
    expect(pageCursor('grabbing')).toBe('grabbing');
    expect(pageCursor('url(https://evil.test/c.png)')).toBe('default');
    expect(pageCursor('auto')).toBe('default');
  });
});
