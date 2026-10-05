/**
 * Theme constants
 * Color themes for multi-theme support with light/dark mode variants
 */

import type { ColorTheme, ColorThemeDefinition } from '../types/settings';

// ============================================
// Color Themes
// ============================================

/**
 * All available color themes with preview colors for the theme selector.
 * Each theme has both light and dark mode variants defined in CSS.
 */
export const COLOR_THEMES: ColorThemeDefinition[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Oscura-inspired with pale yellow accent',
    previewColors: { bg: '#F2F2ED', accent: '#E6E7A3', darkBg: '#0B0B0F', darkAccent: '#E6E7A3' }
  },
  {
    id: 'claude',
    name: 'Claude',
    description: 'Flat warm neutrals with a terracotta accent',
    previewColors: { bg: '#FAF9F5', accent: '#C6613F', darkBg: '#151515', darkAccent: '#D97757' }
  }
];

/** Fallback color theme used when a saved theme is missing or no longer exists */
export const DEFAULT_COLOR_THEME: ColorTheme = 'default';

/**
 * Normalize a (possibly stale or unknown) saved color theme id.
 * Themes that were removed in past releases (or any unknown value) fall back to the default theme.
 */
export function sanitizeColorTheme(value: unknown): ColorTheme {
  return COLOR_THEMES.some((theme) => theme.id === value) ? (value as ColorTheme) : DEFAULT_COLOR_THEME;
}
