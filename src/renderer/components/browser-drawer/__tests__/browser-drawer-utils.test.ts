import { describe, it, expect } from 'vitest';
import { addressToUrl, alignedViewportLength, devicePixelOffset, isPasteShortcut, mouseButton, pageLabel } from '../browser-drawer-utils';

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
    expect(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isPasteShortcut({ key: 'V', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPasteShortcut({ key: 'v', ctrlKey: false, metaKey: false })).toBe(false);
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
