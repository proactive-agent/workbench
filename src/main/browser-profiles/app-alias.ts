/**
 * Microsoft Store apps (Firefox's MSIX package) start through an app execution alias in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`. Playwright checks a browser's executable with stat,
 * which fails on an alias (EACCES), so runs launch the alias's target: the package's own
 * executable, whose path names the version. The alias is what's stored, so a chosen profile keeps
 * working after the Store updates the browser.
 */
import { readlinkSync } from 'fs';
import { isWindows } from '../platform';

const APP_ALIAS_FOLDER = /[\\/]Microsoft[\\/]WindowsApps[\\/]/i;

/** The executable an app execution alias points at; any other path is returned as it is */
export function appAliasTarget(executablePath: string): string {
  if (!isWindows() || !APP_ALIAS_FOLDER.test(executablePath)) return executablePath;
  try {
    // A reparse point read, no process: cheap enough for the sync run-config builders
    return readlinkSync(executablePath);
  } catch {
    return executablePath;
  }
}
