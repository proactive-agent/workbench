import { describe, expect, it } from 'vitest';
import { labelledNodes } from './graph-labels';

describe('graph labels', () => {
  const neighbours = [new Set([1, 2]), new Set([0]), new Set([0]), new Set<number>()];

  it('shows no names without a hovered node', () => {
    expect(labelledNodes(null, neighbours).size).toBe(0);
  });

  it('shows the hovered node and its neighbours', () => {
    expect([...labelledNodes(0, neighbours)].sort()).toEqual([0, 1, 2]);
    expect([...labelledNodes(1, neighbours)].sort()).toEqual([0, 1]);
  });

  it('shows just the hovered node when it has no neighbours', () => {
    expect([...labelledNodes(3, neighbours)]).toEqual([3]);
  });
});
