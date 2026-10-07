import { TITLE_BAR_OVERLAY_HEIGHT } from '../../shared/constants';

// macOS draws its own traffic lights (the sidebar header leaves room for them); on Windows/Linux
// the window controls overlay the top-right corner, so content areas start below them.
// The renderer can't reach the platform module, so detect macOS like the shortcut hints do.
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/** Height (px) of the draggable strip at the top of content areas, under the window controls */
export const TITLE_BAR_STRIP_HEIGHT = IS_MAC ? 0 : TITLE_BAR_OVERLAY_HEIGHT;
