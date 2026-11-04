/**
 * Device pixels per CSS pixel for the browser drawer: what the browsers render at
 * (display-scale.ts) and what the drawer's frames are asked at (browser-drawer-service.ts). Pure, so
 * both use one rule without the service loading Electron's screen module
 */

/** At most this many device pixels per CSS pixel (4x the pixels at 1, like a Retina screen) */
export const MAX_PIXEL_SCALE = 2;

/** A scale within 1..MAX_PIXEL_SCALE, to two decimals (anything that isn't a number: 1) */
export function clampPixelScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(Math.max(n, 1), MAX_PIXEL_SCALE) * 100) / 100;
}
