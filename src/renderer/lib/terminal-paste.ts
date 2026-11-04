/**
 * What a paste into an agent window sends. Claude Code reads clipboard images itself, on a key that
 * depends on where it runs: Alt+V on Windows (Ctrl+V is the terminal's paste there), Ctrl+V on Linux
 * and in WSL (which also takes Alt+V). Files copied in a file manager arrive as files with paths on
 * disk, which are pasted as their paths: Claude Code attaches image paths as images.
 */
export type TerminalPaste =
  | { kind: 'files'; paths: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'image' }
  | { kind: 'none' };

/** Decide what a paste event carries: copied files first, then text, then an image with no file behind it */
export function readTerminalPaste(data: DataTransfer, pathForFile: (file: File) => string): TerminalPaste {
  const paths = Array.from(data.files ?? [])
    .map((file) => pathForFile(file))
    .filter((path) => path.length > 0);
  if (paths.length > 0) return { kind: 'files', paths };

  const text = data.getData('text/plain');
  // Under WSLg a screenshot copied in Windows arrives as "text" holding the bitmap's bytes (`BM...`).
  // Text never has NUL characters in it, so that is an image for Claude Code to read itself
  if (text.includes('\0')) return { kind: 'image' };
  if (text) return { kind: 'text', text };

  const hasImage = Array.from(data.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  return hasImage ? { kind: 'image' } : { kind: 'none' };
}

/** Paths separated by spaces, each quoted when it has whitespace in it */
export function formatPastedPaths(paths: string[]): string {
  return paths.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(' ');
}

/** The key that makes Claude Code read an image from the clipboard: Alt+V on Windows (works in WSL too), Ctrl+V elsewhere */
export function imagePasteKey(isWindowsHost: boolean): string {
  return isWindowsHost ? '\x1bv' : '\x16';
}
