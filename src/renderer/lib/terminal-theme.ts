/**
 * Dark terminal color theme for xterm.js (used by useXterm.ts in dark mode).
 *
 * Dark scheme on the dark sidebar color (#111111) with Claude's terracotta cursor;
 * ANSI colors stay muted pastels.
 */
export const DEFAULT_TERMINAL_THEME = {
  background: '#111111',
  foreground: '#F0EFEC',
  cursor: '#D97757',
  selectionBackground: '#D9775740',
  selectionForeground: '#F0EFEC',
  black: '#1A1A1F',
  red: '#FF6B6B',
  green: '#87D687',
  yellow: '#D6D876',
  blue: '#6BB3FF',
  magenta: '#C792EA',
  cyan: '#89DDFF',
  white: '#E8E6E3',
  brightBlack: '#4A4A50',
  brightRed: '#FF8A8A',
  brightGreen: '#A5E6A5',
  brightYellow: '#E8E87A',
  brightBlue: '#8AC4FF',
  brightMagenta: '#DEB3FF',
  brightCyan: '#A6E8FF',
  brightWhite: '#FFFFFF',
} as const;

/**
 * Light terminal theme: the light sidebar color (#FBFBF9) with near-black text, Claude's
 * darker terracotta cursor and ANSI colors darkened for contrast on a light background.
 */
export const LIGHT_TERMINAL_THEME = {
  background: '#FBFBF9',
  foreground: '#1F1E1D',
  cursor: '#C6613F',
  selectionBackground: '#C6613F33',
  selectionForeground: '#1F1E1D',
  black: '#1F1E1D',
  red: '#C0392B',
  green: '#2E7D32',
  yellow: '#8A6D00',
  blue: '#1D5FB4',
  magenta: '#8E44AD',
  cyan: '#00838F',
  white: '#6B6A66',
  brightBlack: '#52514E',
  brightRed: '#D84A3A',
  brightGreen: '#388E3C',
  brightYellow: '#A07F00',
  brightBlue: '#2A78D6',
  brightMagenta: '#9C4DCC',
  brightCyan: '#00838F',
  brightWhite: '#3D3D3A',
} as const;

/** Terminal theme matching the app's current light/dark mode (the `dark` class on <html>) */
export function getTerminalTheme(): typeof DEFAULT_TERMINAL_THEME | typeof LIGHT_TERMINAL_THEME {
  return document.documentElement.classList.contains('dark') ? DEFAULT_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

/**
 * Type for terminal theme with optional cursorAccent override
 */
export type TerminalTheme = typeof DEFAULT_TERMINAL_THEME & {
  cursorAccent?: string;
};
