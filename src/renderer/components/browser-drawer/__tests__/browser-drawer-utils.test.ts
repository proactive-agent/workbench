import { describe, it, expect } from 'vitest';
import { addressToUrl, isPasteShortcut, mouseButton, pageLabel } from '../browser-drawer-utils';

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
