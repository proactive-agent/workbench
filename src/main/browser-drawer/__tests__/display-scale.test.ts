import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, screen: { getAllDisplays: () => [], on: vi.fn() } }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { browserScaleFor } from '../display-scale';

describe("browsers' display scale", () => {
  it('follows the densest screen, from 1 to 2', () => {
    expect(browserScaleFor([1])).toBe(1);
    expect(browserScaleFor([1, 2])).toBe(2);
    expect(browserScaleFor([1.25, 1.5])).toBe(1.5);
    expect(browserScaleFor([3])).toBe(2);
    expect(browserScaleFor([])).toBe(1);
    expect(browserScaleFor([Number.NaN, 0.5])).toBe(1);
  });
});
