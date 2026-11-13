import { createContext } from 'react';

/**
 * How a row that is about to relaunch the app gets everything the user edited onto disk first.
 *
 * The settings dialog saves its whole settings object after a short pause, so until that timer
 * fires a theme or a font the user just picked lives only in the dialog's state. Saving a row's
 * value on its own and relaunching would throw those edits away, and the dialog is the only place
 * that knows what is pending, so it provides its flush and the rows that restart (Shell, Browser
 * runtime) await it. It reports whether everything is saved: a failed save must leave the app
 * running rather than restart it with the old values.
 */
export const SettingsFlushContext = createContext<(() => Promise<boolean>) | null>(null);

export const SettingsFlushProvider = SettingsFlushContext.Provider;
