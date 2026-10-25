/**
 * Layout of the agent windows grid (Agents page) without empty cells.
 *
 * The grid stays near-square (1x1, 1x2, 2x2, 2x3, 3x3, 3x4, ...) and grows either by a row or
 * by a column. The windows of the newest, unfilled line share it equally:
 * - a new bottom row (rows == columns): its windows split the whole width
 * - a new right column (columns > rows): its windows split the whole height
 * The other windows fill the block above / to the left of it in reading order.
 */

/** A window's place in the CSS grid (1-based lines, as grid-row / grid-column take them) */
export interface TerminalGridCell {
  row: number;
  rowSpan: number;
  column: number;
  columnSpan: number;
}

export interface TerminalGridLayout {
  /** Number of equal CSS grid rows */
  rows: number;
  /** Number of equal CSS grid columns */
  columns: number;
  /** One cell per window, in the windows' order */
  cells: TerminalGridCell[];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

export function computeTerminalGridLayout(count: number): TerminalGridLayout {
  if (count <= 0) return { rows: 0, columns: 0, cells: [] };
  const cols = count === 2 ? 2 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cells: TerminalGridCell[] = [];

  if (cols > rows) {
    // Grown by a column: a (cols - 1)-wide block, then the right column top to bottom
    const blockCols = cols - 1;
    const extra = count - rows * blockCols;
    const units = lcm(rows, extra);
    for (let i = 0; i < count - extra; i++) {
      cells.push({
        row: Math.floor(i / blockCols) * (units / rows) + 1,
        rowSpan: units / rows,
        column: (i % blockCols) + 1,
        columnSpan: 1,
      });
    }
    for (let j = 0; j < extra; j++) {
      cells.push({ row: j * (units / extra) + 1, rowSpan: units / extra, column: cols, columnSpan: 1 });
    }
    return { rows: units, columns: cols, cells };
  }

  // Grown by a row: a block of full rows, then the bottom row left to right
  const extra = count - cols * (rows - 1);
  const units = lcm(cols, extra);
  for (let i = 0; i < count - extra; i++) {
    cells.push({
      row: Math.floor(i / cols) + 1,
      rowSpan: 1,
      column: (i % cols) * (units / cols) + 1,
      columnSpan: units / cols,
    });
  }
  for (let j = 0; j < extra; j++) {
    cells.push({ row: rows, rowSpan: 1, column: j * (units / extra) + 1, columnSpan: units / extra });
  }
  return { rows, columns: units, cells };
}

/** A window's box in the grid area, as fractions (0 to 1) of its width and height */
export interface TerminalBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Layout of the agent windows grid when some windows are wider (Live agent: an agent window
 * shows its graph next to the terminal and counts as two windows).
 *
 * A window of weight w takes w slots. The rows are those of the plain layout for that many
 * slots; the windows fill them in reading order (each row as full as it can be while all fit),
 * and share a row's width by weight, so a weight-2 window is twice as wide as a weight-1
 * window next to it. Rows that end up shorter are shared by their windows, as in the plain
 * layout. Returns boxes rather than grid cells: rows with different slot counts would need the
 * least common multiple of those counts as grid columns.
 */
export function computeWeightedTerminalLayout(weights: number[]): TerminalBox[] {
  if (weights.length === 0) return [];
  const slots = weights.reduce((sum, w) => sum + w, 0);
  const plainColumns = slots === 2 ? 2 : Math.ceil(Math.sqrt(slots));
  const maxRows = Math.ceil(slots / plainColumns);

  // Windows split into rows of at most `limit` slots, in reading order
  const packRows = (limit: number): number[][] => {
    const rows: number[][] = [];
    let current: number[] = [];
    let total = 0;
    weights.forEach((w, index) => {
      if (current.length > 0 && total + w > limit) {
        rows.push(current);
        current = [];
        total = 0;
      }
      current.push(index);
      total += w;
    });
    rows.push(current);
    return rows;
  };

  // The smallest row size that fits every window into the plain layout's rows
  let limit = Math.max(...weights);
  let rows = packRows(limit);
  while (rows.length > maxRows) {
    limit++;
    rows = packRows(limit);
  }

  const boxes: TerminalBox[] = new Array(weights.length);
  const height = 1 / rows.length;
  rows.forEach((row, rowIndex) => {
    const rowSlots = row.reduce((sum, index) => sum + weights[index], 0);
    let x = 0;
    for (const index of row) {
      const width = weights[index] / rowSlots;
      boxes[index] = { x, y: rowIndex * height, width, height };
      x += width;
    }
  });
  return boxes;
}

/** The window id a drag is over: its own sortable box, or the file drop zone inside it */
export function overWindowId(id: string): string {
  return id.startsWith('terminal-') ? id.slice('terminal-'.length) : id;
}

/**
 * The grid order while a window is dragged over another, from the order at drag start: the dragged
 * one takes the other's place, the windows between them shift by one. Unchanged (the same array)
 * when there is nothing to move, e.g. over its own place.
 */
export function movePreviewOrder(order: string[], activeId: string, overId: string): string[] {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * The window to move the dragged one onto, so the stored order becomes the previewed one: the
 * window that held the dragged one's final place before the drag (undefined when it didn't move).
 */
export function dropTargetId(original: string[], preview: string[], activeId: string): string | undefined {
  const target = original[preview.indexOf(activeId)];
  return target && target !== activeId ? target : undefined;
}
