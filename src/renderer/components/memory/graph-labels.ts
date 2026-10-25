/**
 * Nodes whose names the graph view draws: none by default, and while a node is hovered only the
 * highlighted ones (the hovered node and its neighbours).
 */
export function labelledNodes(hovered: number | null, neighbours: ReadonlyArray<ReadonlySet<number>>): Set<number> {
  const show = new Set<number>();
  if (hovered === null) return show;
  show.add(hovered);
  for (const index of neighbours[hovered] ?? []) show.add(index);
  return show;
}
