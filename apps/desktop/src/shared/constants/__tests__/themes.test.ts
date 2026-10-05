import { describe, it, expect } from 'vitest';
import { COLOR_THEMES, DEFAULT_COLOR_THEME, sanitizeColorTheme } from '../themes';

describe('COLOR_THEMES', () => {
  it('contains only the default and claude themes', () => {
    expect(COLOR_THEMES.map((theme) => theme.id)).toEqual(['default', 'claude']);
  });
});

describe('sanitizeColorTheme', () => {
  it('keeps known themes', () => {
    expect(sanitizeColorTheme('default')).toBe('default');
    expect(sanitizeColorTheme('claude')).toBe('claude');
  });

  it('falls back to the default theme for removed or unknown values', () => {
    expect(sanitizeColorTheme('retired-theme')).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme('not-a-theme')).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(undefined)).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(null)).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(42)).toBe(DEFAULT_COLOR_THEME);
  });
});
