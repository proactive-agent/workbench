import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ clipboard: { read: vi.fn(() => '') } }));

import { parseFileUris } from '../clipboard-files';

describe('parseFileUris', () => {
  it('turns file URIs into paths and skips other lines', () => {
    expect(parseFileUris('file:///home/me/My%20Pictures/shot.png\r\nfile:///tmp/a.txt\n')).toEqual([
      '/home/me/My Pictures/shot.png',
      '/tmp/a.txt',
    ]);
  });

  it("reads GNOME's copied-files form", () => {
    expect(parseFileUris('copy\nfile:///home/me/notes.txt')).toEqual(['/home/me/notes.txt']);
  });

  it('returns nothing for text without file URIs', () => {
    expect(parseFileUris('')).toEqual([]);
    expect(parseFileUris('https://example.com')).toEqual([]);
  });
});
