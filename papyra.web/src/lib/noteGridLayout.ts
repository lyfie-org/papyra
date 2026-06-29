// Pure layout + drag math for the notes desk, extracted from DraggableNoteGrid so
// it can be unit-tested without a DOM or dnd-kit. No React, no side effects.

export const GAP = 16;
export const MIN_COL = 250;
export const EST_H = 200; // fallback height before a card is measured

export interface Box { x: number; y: number }
export interface Center { id: string; cx: number; cy: number }
export interface Placed { boxes: Map<string, Box>; centers: Center[]; height: number }

// Columns + column width for a container width (~MIN_COL per column).
export function columnsFor(width: number): { cols: number; colW: number } {
  const cols = Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
  const colW = width > 0 ? (width - (cols - 1) * GAP) / cols : MIN_COL;
  return { cols, colW };
}

// Shortest-column masonry packing. `gapAt` reserves a slot (the dragged card's
// height) at an index so neighbours visibly part to make room.
export function pack(
  ids: string[], heights: Map<string, number>, cols: number, colW: number,
  gapAt?: { index: number; h: number },
): Placed {
  const colH = new Array(Math.max(1, cols)).fill(0);
  const boxes = new Map<string, Box>();
  const centers: Center[] = [];
  const place = (h: number, id?: string) => {
    let c = 0;
    for (let i = 1; i < colH.length; i++) if (colH[i] < colH[c]) c = i;
    const x = c * (colW + GAP);
    const y = colH[c];
    if (id) { boxes.set(id, { x, y }); centers.push({ id, cx: x + colW / 2, cy: y + h / 2 }); }
    colH[c] += h + GAP;
  };
  ids.forEach((id, i) => {
    if (gapAt && i === gapAt.index) place(gapAt.h);
    place(heights.get(id) ?? EST_H, id);
  });
  if (gapAt && gapAt.index >= ids.length) place(gapAt.h);
  return { boxes, centers, height: Math.max(0, ...colH) - GAP };
}

// Insertion index for a point (container-relative) given the laid-out centers:
// nearest card, then before/after it by vertical (then horizontal) position.
export function indexFromPoint(centers: Center[], px: number, py: number): number {
  if (centers.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  centers.forEach((c, i) => {
    const d = (c.cx - px) ** 2 + (c.cy - py) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  const c = centers[best];
  const after = py > c.cy + 4 || (Math.abs(py - c.cy) <= 4 && px > c.cx);
  return after ? best + 1 : best;
}

// The two ids a dropped card lands between, given the target list (with the dragged
// id already removed) and the insertion index.
export function neighborsAt(ids: string[], index: number): { aboveId?: string; belowId?: string } {
  return { aboveId: index > 0 ? ids[index - 1] : undefined, belowId: index < ids.length ? ids[index] : undefined };
}
