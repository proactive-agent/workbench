/**
 * The browser bridge's messages over stdio
 * ========================================
 *
 * Each message is a JSON header, optionally with bytes (a frame's JPEG), so frames aren't
 * inflated by base64: `WB` (two bytes), the header's length and the bytes' length (unsigned
 * 32-bit, big endian), the header (UTF-8 JSON), the bytes. The header names the field the bytes
 * belong in (`$bytes`). browser-bridge.cjs has the same codec in plain Node.
 */

const MAGIC_0 = 0x57; // W
const MAGIC_1 = 0x42; // B
const PREFIX_LENGTH = 10;
/** A message larger than this is corrupt (a frame of a 4096x4096 viewport is far smaller) */
const MAX_PART_LENGTH = 64 * 1024 * 1024;
/** The header field that says which field the bytes go in */
const BYTES_FIELD = '$bytes';

/** One message as bytes: a field holding a Uint8Array (at most one) is sent as raw bytes */
export function encodeBridgeMessage(message: Record<string, unknown>): Buffer {
  let bytes: Uint8Array | null = null;
  const header: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (value instanceof Uint8Array && !bytes) {
      bytes = value;
      header[BYTES_FIELD] = key;
    } else {
      header[key] = value;
    }
  }
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const prefix = Buffer.alloc(PREFIX_LENGTH);
  prefix[0] = MAGIC_0;
  prefix[1] = MAGIC_1;
  prefix.writeUInt32BE(json.length, 2);
  prefix.writeUInt32BE(bytes?.length ?? 0, 6);
  return Buffer.concat(bytes ? [prefix, json, bytes] : [prefix, json]);
}

/**
 * Reads messages from a byte stream. Bytes that aren't a message (a stray write to stdout) are
 * skipped up to the next message's start, reported once per run through `onNoise`
 */
export function createBridgeMessageReader(
  onMessage: (message: Record<string, unknown>) => void,
  onNoise: (skipped: number) => void = () => undefined,
): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  // Chunks of a message still arriving, joined once all of it is there: joining each chunk as it
  // came copied a multi-megabyte frame over again for every 64 KB of it
  let waiting: Buffer[] = [];
  let waitingLength = 0;
  /** The length `buffer` needs for the message it starts (0: not known yet) */
  let needed = 0;
  return (chunk) => {
    waiting.push(chunk);
    waitingLength += chunk.length;
    if (needed > 0 && buffer.length + waitingLength < needed) return;
    const parts = buffer.length ? [buffer, ...waiting] : waiting;
    buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    waiting = [];
    waitingLength = 0;
    needed = 0;
    for (;;) {
      // Up to the next message's start
      let start = 0;
      while (start < buffer.length && !(buffer[start] === MAGIC_0 && (start + 1 >= buffer.length || buffer[start + 1] === MAGIC_1))) start++;
      if (start > 0) {
        onNoise(start);
        buffer = buffer.subarray(start);
      }
      if (buffer.length < PREFIX_LENGTH) return;
      const headerLength = buffer.readUInt32BE(2);
      const bytesLength = buffer.readUInt32BE(6);
      if (headerLength > MAX_PART_LENGTH || bytesLength > MAX_PART_LENGTH) {
        // Not a real message start: look further
        onNoise(1);
        buffer = buffer.subarray(1);
        continue;
      }
      const total = PREFIX_LENGTH + headerLength + bytesLength;
      if (buffer.length < total) {
        needed = total;
        return;
      }
      const headerText = buffer.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength).toString('utf-8');
      const bytes = buffer.subarray(PREFIX_LENGTH + headerLength, total);
      buffer = buffer.subarray(total);
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(headerText);
      } catch {
        onNoise(total);
        continue;
      }
      if (!header || typeof header !== 'object') continue;
      const field = header[BYTES_FIELD];
      delete header[BYTES_FIELD];
      // A copy: the buffer the bytes came in is reused for what follows
      if (typeof field === 'string') header[field] = new Uint8Array(bytes);
      onMessage(header);
    }
  };
}
