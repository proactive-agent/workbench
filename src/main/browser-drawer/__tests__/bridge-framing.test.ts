import { describe, it, expect } from 'vitest';
import { createBridgeMessageReader, encodeBridgeMessage } from '../bridge-framing';

describe('browser bridge framing', () => {
  it('carries headers and raw bytes, whole or split across chunks', () => {
    const got: Record<string, unknown>[] = [];
    const read = createBridgeMessageReader((message) => got.push(message));
    const frame = encodeBridgeMessage({ type: 'frame', pageId: 'p#1', viewers: [3], data: new Uint8Array([255, 216, 0, 87, 66]), width: 800, height: 600 });
    const pages = encodeBridgeMessage({ type: 'pages', pages: [{ id: 'p#1', title: 'Grüße' }] });
    const all = Buffer.concat([frame, pages]);
    // Byte by byte
    for (let i = 0; i < all.length; i++) read(all.subarray(i, i + 1));
    // Both at once
    read(all);
    expect(got).toHaveLength(4);
    expect(got[0]).toEqual({ type: 'frame', pageId: 'p#1', viewers: [3], data: new Uint8Array([255, 216, 0, 87, 66]), width: 800, height: 600 });
    expect(got[1]).toEqual({ type: 'pages', pages: [{ id: 'p#1', title: 'Grüße' }] });
    expect(got[2]).toEqual(got[0]);
    expect(got[0].data).toBeInstanceOf(Uint8Array);
  });

  it('reads a large frame that arrives in many chunks, with messages before and after it in the same chunks', () => {
    const got: Record<string, unknown>[] = [];
    const read = createBridgeMessageReader((message) => got.push(message));
    const data = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const all = Buffer.concat([
      encodeBridgeMessage({ type: 'log', message: 'before' }),
      encodeBridgeMessage({ type: 'frame', pageId: 'p#1', data, width: 800, height: 600 }),
      encodeBridgeMessage({ type: 'log', message: 'after' }),
    ]);
    // Pipe-sized chunks that cut through every message
    for (let i = 0; i < all.length; i += 65536) read(all.subarray(i, i + 65536));
    expect(got.map((message) => message.type)).toEqual(['log', 'frame', 'log']);
    // Compared as bytes (a deep compare of a megabyte, element by element, takes seconds)
    expect(Buffer.from(got[1].data as Uint8Array).equals(Buffer.from(data))).toBe(true);
    expect(got[2]).toEqual({ type: 'log', message: 'after' });
  });

  it('skips bytes that are not a message', () => {
    const got: Record<string, unknown>[] = [];
    let noise = 0;
    const read = createBridgeMessageReader((message) => got.push(message), (skipped) => { noise += skipped; });
    read(Buffer.concat([Buffer.from('warning: something printed\n'), encodeBridgeMessage({ type: 'log', message: 'x' })]));
    expect(got).toEqual([{ type: 'log', message: 'x' }]);
    expect(noise).toBeGreaterThan(0);
  });
});
