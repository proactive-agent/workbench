import type { InterfaceFont } from '../../shared/types';

/** Interface fonts: the CSS font stack for each choice (null keeps the stylesheet's Anthropic Sans stack) */
export const INTERFACE_FONT_STACKS: Record<InterfaceFont, string | null> = {
  'anthropic-sans': null,
  system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  'sans-serif': 'sans-serif',
  inter: "'Inter', sans-serif",
};

export const INTERFACE_FONTS: InterfaceFont[] = ['anthropic-sans', 'system', 'sans-serif', 'inter'];

/** Fonts offered for terminals and agent windows (Dank Mono is bundled; the rest come with the OS) */
export const TERMINAL_FONTS = ['Dank Mono', 'Cascadia Mono', 'Consolas', 'SF Mono'] as const;

/** Font chain for a terminal font: falls back to the bundled Dank Mono where the font isn't installed */
export function terminalFontChain(font: string): string[] {
  return font === 'Dank Mono' ? ['Dank Mono', 'monospace'] : [font, 'Dank Mono', 'monospace'];
}

/** Terminal text sizes offered in Appearance */
export const TERMINAL_FONT_SIZES = { small: 12, medium: 13, large: 15 } as const;

/** Terminal scrollback limits (lines) offered in Appearance */
export const SCROLLBACK_PRESETS = [1000, 10000, 50000, 100000] as const;

/** The option value closest to `value` (saved settings from the old sliders snap to an option) */
export function nearestOption(options: Record<string, number>, value: number): number {
  return Object.values(options).reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best
  );
}
