/**
 * The browser's own shortcuts the browser drawer acts on, as Chrome binds them: Ctrl on Windows
 * and Linux, Cmd on macOS
 */
import { describe, it, expect } from 'vitest';
import { browserShortcut, type ShortcutInput } from '../browser-shortcuts';

const key = (code: string, mods: Partial<Omit<ShortcutInput, 'code'>> = {}): ShortcutInput => ({
  code,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('browserShortcut', () => {
  it('opens, closes and goes round the tabs with Ctrl on Windows and Linux', () => {
    expect(browserShortcut(key('KeyT', { control: true }), false)).toEqual({ kind: 'newTab' });
    expect(browserShortcut(key('KeyW', { control: true }), false)).toEqual({ kind: 'closeTab' });
    expect(browserShortcut(key('F4', { control: true }), false)).toEqual({ kind: 'closeTab' });
    expect(browserShortcut(key('Tab', { control: true }), false)).toEqual({ kind: 'nextTab' });
    expect(browserShortcut(key('Tab', { control: true, shift: true }), false)).toEqual({ kind: 'previousTab' });
    expect(browserShortcut(key('PageDown', { control: true }), false)).toEqual({ kind: 'nextTab' });
    expect(browserShortcut(key('PageUp', { control: true }), false)).toEqual({ kind: 'previousTab' });
    expect(browserShortcut(key('Digit3', { control: true }), false)).toEqual({ kind: 'tab', index: 2 });
    expect(browserShortcut(key('Digit9', { control: true }), false)).toEqual({ kind: 'tab', index: -1 });
  });

  it('reaches the address bar, reloads and goes back and forward', () => {
    for (const input of [key('KeyL', { control: true }), key('KeyD', { alt: true }), key('F6')]) {
      expect(browserShortcut(input, false)).toEqual({ kind: 'address' });
    }
    for (const input of [key('KeyR', { control: true }), key('KeyR', { control: true, shift: true }), key('F5'), key('F5', { control: true })]) {
      expect(browserShortcut(input, false)).toEqual({ kind: 'reload' });
    }
    expect(browserShortcut(key('ArrowLeft', { alt: true }), false)).toEqual({ kind: 'back' });
    expect(browserShortcut(key('ArrowRight', { alt: true }), false)).toEqual({ kind: 'forward' });
  });

  it('uses Cmd on macOS, with its own keys for switching tabs and going back', () => {
    expect(browserShortcut(key('KeyT', { meta: true }), true)).toEqual({ kind: 'newTab' });
    expect(browserShortcut(key('KeyW', { meta: true }), true)).toEqual({ kind: 'closeTab' });
    expect(browserShortcut(key('KeyT', { control: true }), true)).toBeNull();
    expect(browserShortcut(key('Tab', { control: true }), true)).toEqual({ kind: 'nextTab' });
    expect(browserShortcut(key('ArrowRight', { meta: true, alt: true }), true)).toEqual({ kind: 'nextTab' });
    expect(browserShortcut(key('BracketLeft', { meta: true, shift: true }), true)).toEqual({ kind: 'previousTab' });
    expect(browserShortcut(key('BracketLeft', { meta: true }), true)).toEqual({ kind: 'back' });
    expect(browserShortcut(key('BracketRight', { meta: true }), true)).toEqual({ kind: 'forward' });
    expect(browserShortcut(key('Digit1', { meta: true }), true)).toEqual({ kind: 'tab', index: 0 });
    // Alt+Left moves a text field's caret by a word on macOS
    expect(browserShortcut(key('ArrowLeft', { alt: true }), true)).toBeNull();
  });

  it('leaves other keys alone: plain letters, AltGr (Ctrl+Alt) and extra modifiers', () => {
    expect(browserShortcut(key('KeyT'), false)).toBeNull();
    expect(browserShortcut(key('KeyT', { control: true, alt: true }), false)).toBeNull();
    expect(browserShortcut(key('KeyW', { control: true, shift: true }), false)).toBeNull();
    expect(browserShortcut(key('KeyC', { control: true }), false)).toBeNull();
  });

  it('repeats only switching tabs while a key is held', () => {
    expect(browserShortcut(key('Tab', { control: true, isAutoRepeat: true }), false)).toEqual({ kind: 'nextTab' });
    expect(browserShortcut(key('KeyW', { control: true, isAutoRepeat: true }), false)).toBeNull();
    expect(browserShortcut(key('KeyT', { control: true, isAutoRepeat: true }), false)).toBeNull();
  });
});
