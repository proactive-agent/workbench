import { describe, it, expect } from 'vitest';
import {
  computeTerminalGridLayout,
  computeWeightedTerminalLayout,
  dropTargetId,
  movePreviewOrder,
  overWindowId,
  type TerminalBox,
  type TerminalGridLayout,
} from '../terminal-grid-layout';

/** Each window's share of the grid's width and height, and whether the cells tile the grid */
function shares(layout: TerminalGridLayout) {
  const covered = new Set<string>();
  for (const cell of layout.cells) {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.column; c < cell.column + cell.columnSpan; c++) {
        const key = `${r},${c}`;
        expect(covered.has(key)).toBe(false);
        covered.add(key);
      }
    }
  }
  return {
    filled: covered.size === layout.rows * layout.columns,
    sizes: layout.cells.map((cell) => [cell.columnSpan / layout.columns, cell.rowSpan / layout.rows]),
  };
}

describe('computeTerminalGridLayout', () => {
  it('leaves no empty cell for any number of windows', () => {
    for (let count = 1; count <= 24; count++) {
      const layout = computeTerminalGridLayout(count);
      expect(layout.cells).toHaveLength(count);
      expect(shares(layout).filled).toBe(true);
    }
  });

  it('stretches the windows of a new bottom row across the whole width', () => {
    // 3 windows: two on top, the third as wide as both
    expect(shares(computeTerminalGridLayout(3)).sizes).toEqual([[1 / 2, 1 / 2], [1 / 2, 1 / 2], [1, 1 / 2]]);
    // 8 windows: 3 per row, the last row's two share it equally
    const eight = shares(computeTerminalGridLayout(8)).sizes;
    expect(eight.slice(0, 6).every(([w, h]) => w === 1 / 3 && h === 1 / 3)).toBe(true);
    expect(eight.slice(6)).toEqual([[1 / 2, 1 / 3], [1 / 2, 1 / 3]]);
  });

  it('stretches the windows of a new right column across the whole height', () => {
    // 5 windows: a 2x2 block and the fifth as tall as both rows on the right
    const five = computeTerminalGridLayout(5);
    expect(five.cells[4]).toEqual({ row: 1, rowSpan: 2, column: 3, columnSpan: 1 });
    expect(shares(five).sizes[4]).toEqual([1 / 3, 1]);
    // 11 windows: a 3x3 block and two on the right sharing its height
    const eleven = computeTerminalGridLayout(11);
    expect(shares(eleven).sizes.slice(9)).toEqual([[1 / 4, 1 / 2], [1 / 4, 1 / 2]]);
    expect(shares(eleven).sizes.slice(0, 9).every(([w, h]) => w === 1 / 4 && h === 1 / 3)).toBe(true);
  });

  it('keeps full grids as plain equal cells', () => {
    expect(computeTerminalGridLayout(1)).toEqual({ rows: 1, columns: 1, cells: [{ row: 1, rowSpan: 1, column: 1, columnSpan: 1 }] });
    expect(shares(computeTerminalGridLayout(2)).sizes).toEqual([[1 / 2, 1], [1 / 2, 1]]);
    expect(shares(computeTerminalGridLayout(9)).sizes.every(([w, h]) => w === 1 / 3 && h === 1 / 3)).toBe(true);
    expect(computeTerminalGridLayout(0)).toEqual({ rows: 0, columns: 0, cells: [] });
  });
});

describe('computeWeightedTerminalLayout', () => {
  /** Boxes cover the area once: no overlap, no gap */
  function expectTiled(boxes: TerminalBox[]) {
    const area = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
    expect(area).toBeCloseTo(1, 9);
    for (const [i, a] of boxes.entries()) {
      expect(a.x + a.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(a.y + a.height).toBeLessThanOrEqual(1 + 1e-9);
      for (const b of boxes.slice(i + 1)) {
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX > 1e-9 && overlapY > 1e-9).toBe(false);
      }
    }
  }

  it('gives a single agent window the whole area', () => {
    expect(computeWeightedTerminalLayout([2])).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });

  it('makes an agent window twice as wide as a terminal in the same row', () => {
    const boxes = computeWeightedTerminalLayout([1, 2, 1]);
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[1].width).toBeCloseTo(boxes[0].width * 2, 9);
    expectTiled(boxes);
  });

  it('keeps the windows in reading order', () => {
    const boxes = computeWeightedTerminalLayout([2, 1, 1]);
    expect(boxes[0]).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(boxes[1]).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 });
    expect(boxes[2]).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  });

  it('uses the rows of the plain layout for that many slots', () => {
    // Three agent windows are six slots: two rows
    const boxes = computeWeightedTerminalLayout([2, 2, 2]);
    expect(new Set(boxes.map((box) => box.y)).size).toBe(2);
    expectTiled(boxes);
  });

  it('tiles the area for any mix of windows', () => {
    for (let count = 1; count <= 24; count++) {
      for (const pattern of [() => 2, (i: number) => (i % 2 ? 2 : 1), (i: number) => (i % 3 ? 1 : 2)]) {
        const weights = Array.from({ length: count }, (_, i) => pattern(i));
        const boxes = computeWeightedTerminalLayout(weights);
        expect(boxes).toHaveLength(count);
        expectTiled(boxes);
      }
    }
  });
});

describe('dragging a window around the grid', () => {
  const original = ['a', 'b', 'c', 'd'];

  it('previews the dragged window in the place of the one under the cursor', () => {
    expect(movePreviewOrder(original, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(movePreviewOrder(original, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    // Over itself, or over something that isn't a window: the same order, unchanged
    expect(movePreviewOrder(original, 'a', 'a')).toBe(original);
    expect(movePreviewOrder(original, 'a', 'zone')).toBe(original);
  });

  it('reads the window from its file drop zone too', () => {
    expect(overWindowId('terminal-b')).toBe('b');
    expect(overWindowId('b')).toBe('b');
  });

  it('drops onto the window that held the final place, which gives the previewed order', () => {
    // Each preview starts from the drag-start order, so a cursor position always gives the same one
    expect(movePreviewOrder(original, 'a', 'c')).toEqual(movePreviewOrder(original, 'a', 'c'));
    const preview = movePreviewOrder(original, 'a', 'c');
    expect(dropTargetId(original, preview, 'a')).toBe('c');
    expect(movePreviewOrder(original, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(dropTargetId(original, movePreviewOrder(original, 'd', 'a'), 'd')).toBe('a');
    // Back over its own place: nothing to apply
    expect(dropTargetId(original, movePreviewOrder(original, 'b', 'b'), 'b')).toBeUndefined();
  });
});
