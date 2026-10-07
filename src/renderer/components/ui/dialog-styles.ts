/**
 * Shared dialog look (claude.ai settings dialog) so every modal in the app matches: light
 * backdrop, 12px panel on the settings surface with a hairline border, a ghost close button in
 * the top-right corner, a 17px title with muted copy, and actions that flow with the content
 * (no fixed footer bar). The `claude-dialog` class also gives inputs, dropdowns and buttons
 * inside the panel their claude.ai look (see globals.css).
 */

/** Backdrop behind every dialog */
export const DIALOG_OVERLAY_CLASS = [
  'fixed inset-0 z-50 bg-black/40',
  'data-[state=open]:animate-in data-[state=closed]:animate-out',
  'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
].join(' ');

/** Panel surface: rounded corners, hairline border, page background, soft shadow */
export const DIALOG_SURFACE_CLASS = 'claude-dialog rounded-xl border border-border bg-settings-surface text-foreground shadow-2xl';

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
export const DIALOG_DESCRIPTION_CLASS = 'text-sm leading-5 text-(--nav-label-color)';

/** Footer: actions right-aligned below the content, no divider or fixed bar */
export const DIALOG_FOOTER_BAR_CLASS = 'pt-2';
export const DIALOG_FOOTER_ACTIONS_CLASS = 'flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end';
