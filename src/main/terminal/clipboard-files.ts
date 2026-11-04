/**
 * Files copied in a file manager, for pastes into agent windows that arrive empty. Chromium shows
 * copied files to the page on Windows, but not under WSLg (a Linux build of Workbench inside WSL):
 * there a file copied in Windows Explorer reaches the window as an empty text item, so the files are
 * read from the Windows clipboard instead. On other Linux desktops they are the clipboard's
 * `text/uri-list` (or GNOME's `x-special/gnome-copied-files`).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { clipboard } from 'electron';
import { isLinux, isWSL } from '../platform';

const execFileAsync = promisify(execFile);

const POWERSHELL_CANDIDATES = ['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'];
const READ_FILE_DROP_LIST =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';
const TIMEOUT_MS = 10_000;

/** Paths of the files on the clipboard as this process sees them; empty when it holds none */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (isWSL()) return readWindowsClipboardFiles();
  if (isLinux()) return readUriListFiles();
  return [];
}

async function readWindowsClipboardFiles(): Promise<string[]> {
  for (const powershell of POWERSHELL_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', READ_FILE_DROP_LIST], {
        timeout: TIMEOUT_MS,
        windowsHide: true,
      });
      const windowsPaths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return Promise.all(windowsPaths.map(toWslPath));
    } catch {
      // Not on PATH (interop's PATH appending off): try the next candidate
    }
  }
  return [];
}

async function toWslPath(windowsPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('wslpath', ['-u', windowsPath], { timeout: TIMEOUT_MS });
    return stdout.trim() || windowsPath;
  } catch {
    return windowsPath;
  }
}

function readUriListFiles(): string[] {
  const text = clipboard.read('text/uri-list') || clipboard.read('x-special/gnome-copied-files');
  return parseFileUris(text);
}

/** `file://` URIs in a uri-list (or GNOME's "copy\nfile://..." form) as paths; other lines are skipped */
export function parseFileUris(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file://'))
    .flatMap((uri) => {
      try {
        return [fileURLToPath(uri)];
      } catch {
        return [];
      }
    });
}
