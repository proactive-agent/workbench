import { describe, it, expect } from 'vitest';
import { buildAttachmentParts, MAX_INLINE_TEXT_CHARS } from '../insights-attachments';
import type { ImageAttachment } from '../../../../shared/types';

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');

function attachment(overrides: Partial<ImageAttachment>): ImageAttachment {
  return { id: 'id', filename: 'file', mimeType: 'application/octet-stream', size: 1, data: b64('x'), ...overrides };
}

describe('buildAttachmentParts', () => {
  it('returns no parts when there are no attachments', () => {
    expect(buildAttachmentParts(undefined)).toEqual([]);
    expect(buildAttachmentParts([])).toEqual([]);
  });

  it('maps supported images to image parts', () => {
    const [part] = buildAttachmentParts([attachment({ mimeType: 'image/png', data: 'AAAA' })]);
    expect(part).toEqual({ type: 'image', image: 'AAAA', mediaType: 'image/png' });
  });

  it('maps PDFs to file parts', () => {
    const [part] = buildAttachmentParts([attachment({ mimeType: 'application/pdf', filename: 'spec.pdf', data: 'AAAA' })]);
    expect(part).toEqual({ type: 'file', data: 'AAAA', mediaType: 'application/pdf', filename: 'spec.pdf' });
  });

  it('inlines text files with their name', () => {
    const [part] = buildAttachmentParts([attachment({ mimeType: 'text/markdown', filename: 'README.md', data: b64('# Hello') })]);
    expect(part).toEqual({ type: 'text', text: '<attached_file name="README.md">\n# Hello\n</attached_file>' });
  });

  it('sniffs untyped files and inlines them when they contain no NUL bytes', () => {
    const [part] = buildAttachmentParts([attachment({ mimeType: '', filename: 'main.rs', data: b64('fn main() {}') })]);
    expect(part).toMatchObject({ type: 'text' });
    expect((part as { text: string }).text).toContain('fn main() {}');
  });

  it('truncates very large text files', () => {
    const big = 'a'.repeat(MAX_INLINE_TEXT_CHARS + 10);
    const [part] = buildAttachmentParts([attachment({ mimeType: 'text/plain', filename: 'big.txt', data: b64(big) })]);
    const text = (part as { text: string }).text;
    expect(text).toContain('truncated="true"');
    expect(text.length).toBeLessThan(MAX_INLINE_TEXT_CHARS + 100);
  });

  it('references binary files by name only', () => {
    const [part] = buildAttachmentParts([
      attachment({ mimeType: 'application/octet-stream', filename: 'blob.bin', size: 3, data: b64(Buffer.from([0, 1, 2])) })
    ]);
    expect((part as { text: string }).text).toBe(
      '[Attached binary file "blob.bin" (application/octet-stream, 3 bytes) — its contents cannot be read]'
    );
  });

  it('skips attachments without data (e.g. persisted history entries)', () => {
    expect(buildAttachmentParts([attachment({ data: undefined })])).toEqual([]);
  });
});
