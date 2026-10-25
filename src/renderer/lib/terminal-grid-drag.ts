/**
 * Whether a window of the Agents grid is being dragged. While it is, the grid lays the windows out
 * in the order the drop would give them (a live preview), so their sizes change as the cursor
 * moves; refitting each terminal (and resizing its PTY, which makes Claude Code redraw) is held
 * until the drop, which refits every window once (`terminal-refit-all`).
 */
let dragging = false;

export function setTerminalGridDragging(value: boolean): void {
  dragging = value;
}

export function isTerminalGridDragging(): boolean {
  return dragging;
}
