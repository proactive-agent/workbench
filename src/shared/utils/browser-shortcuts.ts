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
 * The browser shortcut a key press is, as Chrome binds them (macOS with Cmd), or null. Held keys
 * repeat only switching tabs (a held Ctrl+W doesn't close every tab)
 */
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
    if (only(input, { control: true }) && code === 'F4') return input.isAutoRepeat ? null : { kind: 'closeTab' };
    if (only(input, { alt: true }) && code === 'ArrowLeft') return { kind: 'back' };
    if (only(input, { alt: true }) && code === 'ArrowRight') return { kind: 'forward' };
    if (only(input, { alt: true }) && code === 'KeyD') return { kind: 'address' };
    if (only(input, {}) && code === 'F6') return { kind: 'address' };
    if ((only(input, {}) || only(input, { control: true })) && code === 'F5') return { kind: 'reload' };
  }
  if (input.isAutoRepeat) return null;
  if (only(input, mod) && code === 'KeyT') return { kind: 'newTab' };
  if (only(input, mod) && code === 'KeyW') return { kind: 'closeTab' };
  if (only(input, mod) && code === 'KeyL') return { kind: 'address' };
  if ((only(input, mod) || only(input, { ...mod, shift: true })) && code === 'KeyR') return { kind: 'reload' };
  return null;
}
