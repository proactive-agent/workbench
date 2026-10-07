/**
 * Default terminal color theme for xterm.js
 *
 * This theme is used consistently across:
 * - useXterm.ts (actual agent terminals)
 * - LivePreviewTerminal.tsx (settings preview terminal)
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
 * Type for terminal theme with optional cursorAccent override
 */
export type TerminalTheme = typeof DEFAULT_TERMINAL_THEME & {
  cursorAccent?: string;
};
