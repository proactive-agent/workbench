/**
 * Shared dialog look (taken from the Settings dialog) so every modal in the app matches:
 * light backdrop, rounded-xl panel on the page background, a ghost close button in the
 * top-right corner, a 17px title with 13px muted copy, and a slim full-width footer bar.
 */

/** Backdrop behind every dialog */
export const DIALOG_OVERLAY_CLASS = [
  'fixed inset-0 z-50 bg-black/40',
  'data-[state=open]:animate-in data-[state=closed]:animate-out',
  'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
].join(' ');

/** Panel surface: rounded corners, hairline border, page background, soft shadow */
export const DIALOG_SURFACE_CLASS = 'rounded-xl border border-border bg-background text-foreground shadow-2xl';

/** Open/close animation (fade with a subtle zoom) */
export const DIALOG_ANIMATION_CLASS = [
  'data-[state=open]:animate-in data-[state=closed]:animate-out',
  'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
  'data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98',
  'duration-200 focus:outline-none'
].join(' ');

/** Ghost close (X) button pinned to the panel's top-right corner */
export const DIALOG_CLOSE_BUTTON_CLASS = [
  'absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg',
  'text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none'
].join(' ');

/** Close icon size/weight inside DIALOG_CLOSE_BUTTON_CLASS */
export const DIALOG_CLOSE_ICON_CLASS = 'h-4 w-4';
export const DIALOG_CLOSE_ICON_STROKE = 1.75;

/** Dialog title (same scale as Settings section headings) */
export const DIALOG_TITLE_CLASS = 'text-[1.0625rem] font-semibold leading-6 text-foreground';

/** Supporting copy under a dialog title */
export const DIALOG_DESCRIPTION_CLASS = 'text-[0.8125rem] leading-5 text-muted-foreground';

/** Footer bar: hairline divider, compact padding, actions right-aligned */
export const DIALOG_FOOTER_BAR_CLASS = 'border-t border-border px-6 py-3';
export const DIALOG_FOOTER_ACTIONS_CLASS = 'flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end';
