/**
 * The browser's own shortcuts in the browser drawer. The drawer's browsers are headless: their
 * window, which handles these, never shows, and keys sent to them only reach the page. So while a
 * drawer is open the main process catches these keys before the page and the app's menu (which
 * binds Ctrl/Cmd+W to closing the window and Ctrl/Cmd+R to reloading the app) and the drawer does
 * what the browser would (browser-drawer-handlers.ts, BrowserDrawer.tsx)
 */

export type BrowserShortcut =
  | { kind: 'newTab' }
  | { kind: 'closeTab' }
  | { kind: 'nextTab' }
  | { kind: 'previousTab' }
  /** The tab at `index` (0-based), or the last one (-1) */
  | { kind: 'tab'; index: number }
  | { kind: 'address' }
  | { kind: 'reload' }
  | { kind: 'back' }
  | { kind: 'forward' };

/** A key press as Electron's before-input-event gives it */
export interface ShortcutInput {
  /** The character the layout types (letters are read by it: Ctrl+Z on AZERTY sits where W is on QWERTY) */
  key?: string;
  code: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  isAutoRepeat?: boolean;
}

/** Which modifiers are down, exactly (others up) */
function only(input: ShortcutInput, mods: { control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): boolean {
  return input.control === !!mods.control && input.shift === !!mods.shift && input.alt === !!mods.alt && input.meta === !!mods.meta;
}

const DIGIT = /^Digit([1-9])$/;

/**
 * The letter a key press types, as Chrome reads shortcuts: the layout's own character (a-z), else,
 * on a layout of another script (Cyrillic, Greek...), the letter at the key's place on a US
 * keyboard
 */
function letterOf(input: ShortcutInput): string | null {
  const typed = input.key?.length === 1 ? input.key.toLowerCase() : '';
  if (/^[a-z]$/.test(typed)) return typed;
  if (!/^\p{L}$/u.test(typed)) return null;
  return /^Key([A-Z])$/.exec(input.code)?.[1].toLowerCase() ?? null;
}

/**
 * Whether a shortcut acts again while its keys are held (switching tabs, going back); a held
 * Ctrl+W or Ctrl+R acts once, its repeats only swallowed (so they reach neither the page nor the
 * app's menu, which would reload the app or close its window)
 */
export function actsWhileHeld(shortcut: BrowserShortcut): boolean {
  return shortcut.kind === 'nextTab' || shortcut.kind === 'previousTab' || shortcut.kind === 'back' || shortcut.kind === 'forward';
}

/** The browser shortcut a key press is, as Chrome binds them (macOS with Cmd), or null */
export function browserShortcut(input: ShortcutInput, mac: boolean): BrowserShortcut | null {
  const { code } = input;
  // Tabs go round with Ctrl+Tab on every platform
  if (code === 'Tab' && only(input, { control: true })) return { kind: 'nextTab' };
  if (code === 'Tab' && only(input, { control: true, shift: true })) return { kind: 'previousTab' };
  const mod = mac ? { meta: true } : { control: true };
  const digit = DIGIT.exec(code);
  if (digit && only(input, mod)) return { kind: 'tab', index: digit[1] === '9' ? -1 : Number(digit[1]) - 1 };
  if (mac) {
    if (only(input, { meta: true, alt: true }) && code === 'ArrowRight') return { kind: 'nextTab' };
    if (only(input, { meta: true, alt: true }) && code === 'ArrowLeft') return { kind: 'previousTab' };
    if (only(input, { meta: true, shift: true }) && code === 'BracketRight') return { kind: 'nextTab' };
    if (only(input, { meta: true, shift: true }) && code === 'BracketLeft') return { kind: 'previousTab' };
    if (only(input, { meta: true }) && code === 'BracketLeft') return { kind: 'back' };
    if (only(input, { meta: true }) && code === 'BracketRight') return { kind: 'forward' };
  } else {
    if (only(input, { control: true }) && code === 'PageDown') return { kind: 'nextTab' };
    if (only(input, { control: true }) && code === 'PageUp') return { kind: 'previousTab' };
    if (only(input, { control: true }) && code === 'F4') return { kind: 'closeTab' };
    if (only(input, { alt: true }) && code === 'ArrowLeft') return { kind: 'back' };
    if (only(input, { alt: true }) && code === 'ArrowRight') return { kind: 'forward' };
    if (only(input, {}) && code === 'F6') return { kind: 'address' };
    if ((only(input, {}) || only(input, { control: true })) && code === 'F5') return { kind: 'reload' };
  }
  const letter = letterOf(input);
  if (!mac && only(input, { alt: true }) && letter === 'd') return { kind: 'address' };
  if (only(input, mod) && letter === 't') return { kind: 'newTab' };
  if (only(input, mod) && letter === 'w') return { kind: 'closeTab' };
  if (only(input, mod) && letter === 'l') return { kind: 'address' };
  if ((only(input, mod) || only(input, { ...mod, shift: true })) && letter === 'r') return { kind: 'reload' };
  return null;
}
