/**
 * Insights attachments → model message content parts
 *
 * Converts files attached in the Insights composer (base64 payloads) into AI SDK
 * content parts: images become image parts, PDFs become file parts, and text/code
 * files are inlined as text. Other binary files are referenced by name only.
 */

import type { FilePart, ImagePart, TextPart } from 'ai';
import type { ImageAttachment } from '../../../shared/types';

/** Image types every supported vision provider accepts */
const VISION_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Non-`text/*` MIME types that are still plain text */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-httpd-php',
  'image/svg+xml',
]);

/** Inlined text is capped so a single large file can't exhaust the context window */
export const MAX_INLINE_TEXT_CHARS = 200_000;

/** How many leading bytes are scanned for NUL bytes when sniffing unknown types */
const BINARY_SNIFF_BYTES = 8192;

export type AttachmentPart = TextPart | ImagePart | FilePart;

function looksLikeText(buffer: Buffer, mimeType: string): boolean {
  if (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType)) return true;
  // Unknown or generic types (e.g. source files the OS has no MIME type for): sniff for binary content
  if (mimeType === '' || mimeType === 'application/octet-stream') {
    return !buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  }
  return false;
}

/** Build model content parts for the attachments sent with a message. */
export function buildAttachmentParts(attachments: ImageAttachment[] | undefined): AttachmentPart[] {
  if (!attachments || attachments.length === 0) return [];

  const parts: AttachmentPart[] = [];
  for (const attachment of attachments) {
    if (!attachment.data) continue;
    const mimeType = attachment.mimeType || 'application/octet-stream';

    if (VISION_IMAGE_TYPES.has(mimeType)) {
      parts.push({ type: 'image', image: attachment.data, mediaType: mimeType });
      continue;
    }

    if (mimeType === 'application/pdf') {
      parts.push({ type: 'file', data: attachment.data, mediaType: mimeType, filename: attachment.filename });
      continue;
    }

    const buffer = Buffer.from(attachment.data, 'base64');
    if (looksLikeText(buffer, mimeType)) {
      let text = buffer.toString('utf8');
      const truncated = text.length > MAX_INLINE_TEXT_CHARS;
      if (truncated) text = text.slice(0, MAX_INLINE_TEXT_CHARS);
      parts.push({
        type: 'text',
        text: `<attached_file name="${attachment.filename}"${truncated ? ' truncated="true"' : ''}>\n${text}\n</attached_file>`,
      });
      continue;
    }

    parts.push({
      type: 'text',
      text: `[Attached binary file "${attachment.filename}" (${mimeType}, ${attachment.size} bytes) — its contents cannot be read]`,
    });
  }
  return parts;
}
