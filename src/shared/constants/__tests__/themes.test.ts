import { describe, it, expect } from 'vitest';
import { COLOR_THEMES, DEFAULT_COLOR_THEME, sanitizeColorTheme } from '../themes';

describe('COLOR_THEMES', () => {
  it('contains only the default theme', () => {
    expect(COLOR_THEMES.map((theme) => theme.id)).toEqual(['default']);
  });
});

describe('sanitizeColorTheme', () => {
  it('keeps known themes', () => {
    expect(sanitizeColorTheme('default')).toBe('default');
  });

  it('maps the removed lime theme to default', () => {
    expect(sanitizeColorTheme('lime')).toBe('default');
  });

  it('maps the renamed claude theme to default', () => {
    expect(sanitizeColorTheme('claude')).toBe('default');
  });

  it('falls back to the default theme for removed or unknown values', () => {
    expect(sanitizeColorTheme('retired-theme')).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme('not-a-theme')).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(undefined)).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(null)).toBe(DEFAULT_COLOR_THEME);
    expect(sanitizeColorTheme(42)).toBe(DEFAULT_COLOR_THEME);
  });
});
