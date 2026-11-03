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

  it('skips bytes that are not a message', () => {
    const got: Record<string, unknown>[] = [];
    let noise = 0;
    const read = createBridgeMessageReader((message) => got.push(message), (skipped) => { noise += skipped; });
    read(Buffer.concat([Buffer.from('warning: something printed\n'), encodeBridgeMessage({ type: 'log', message: 'x' })]));
    expect(got).toEqual([{ type: 'log', message: 'x' }]);
    expect(noise).toBeGreaterThan(0);
  });
});
