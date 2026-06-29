import { describe, it, expect } from 'vitest';
import { columnsFor, pack, indexFromPoint, neighborsAt, GAP } from './noteGridLayout';

describe('columnsFor', () => {
  it('uses ~250px columns and never fewer than 1', () => {
    expect(columnsFor(0).cols).toBe(1);
    expect(columnsFor(300).cols).toBe(1);
    expect(columnsFor(600).cols).toBe(2);
    expect(columnsFor(1000).cols).toBe(3);
  });

  it('column width fills the row minus gaps', () => {
    const { cols, colW } = columnsFor(1000);
    expect(cols * colW + (cols - 1) * GAP).toBeCloseTo(1000);
  });
});

describe('pack', () => {
  const h = (entries: [string, number][]) => new Map(entries);

  it('fills the shortest column (round-robin for equal heights)', () => {
    const heights = h([['a', 100], ['b', 100], ['c', 100], ['d', 100]]);
    const { boxes } = pack(['a', 'b', 'c', 'd'], heights, 2, 200);
    expect(boxes.get('a')).toEqual({ x: 0, y: 0 });
    expect(boxes.get('b')).toEqual({ x: 216, y: 0 });      // col 2 (200 + GAP)
    expect(boxes.get('c')).toEqual({ x: 0, y: 116 });       // back to col 1 (100 + GAP)
    expect(boxes.get('d')).toEqual({ x: 216, y: 116 });
  });

  it('routes the next card to the genuinely shorter column', () => {
    // a is tall, so b/c should stack in the second column before a's column is used.
    const heights = h([['a', 300], ['b', 100], ['c', 100]]);
    const { boxes } = pack(['a', 'b', 'c'], heights, 2, 200);
    expect(boxes.get('a')).toEqual({ x: 0, y: 0 });
    expect(boxes.get('b')).toEqual({ x: 216, y: 0 });
    expect(boxes.get('c')).toEqual({ x: 216, y: 116 });     // still shorter than a's 300+GAP
  });

  it('gapAt reserves a slot so following cards shift down', () => {
    const heights = h([['a', 100], ['b', 100]]);
    const withGap = pack(['a', 'b'], heights, 1, 200, { index: 0, h: 100 });
    // The reserved gap occupies the top of the single column, pushing a/b down.
    expect(withGap.boxes.get('a')).toEqual({ x: 0, y: 116 });
    expect(withGap.boxes.get('b')).toEqual({ x: 0, y: 232 });
  });
});

describe('indexFromPoint', () => {
  const centers = [
    { id: 'a', cx: 100, cy: 50 },
    { id: 'b', cx: 100, cy: 200 },
  ];

  it('returns 0 for an empty section', () => {
    expect(indexFromPoint([], 10, 10)).toBe(0);
  });

  it('inserts before a card when the point is above its centre', () => {
    expect(indexFromPoint(centers, 100, 30)).toBe(0);
  });

  it('inserts after a card when the point is below its centre', () => {
    expect(indexFromPoint(centers, 100, 260)).toBe(2);
  });

  it('lands between two cards', () => {
    expect(indexFromPoint(centers, 100, 160)).toBe(1); // nearest b, above its centre
  });
});

describe('hit-test stability (no vibration)', () => {
  // A single column of 4 equal cards. Sweeping the pointer top→bottom must yield a
  // monotonically non-decreasing index — never bouncing — which is what keeps the
  // make-room gap from oscillating.
  const heights = new Map([['a', 100], ['b', 100], ['c', 100], ['d', 100]]);
  const base = pack(['a', 'b', 'c', 'd'], heights, 1, 200);

  it('insertion index is monotonic as the pointer descends', () => {
    let last = -1;
    for (let py = 0; py <= base.height; py += 10) {
      const idx = indexFromPoint(base.centers, 100, py);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
    expect(last).toBe(4); // ends past the last card
  });

  it('the same point yields the same index every call (idempotent)', () => {
    const p = { x: 100, y: 175 };
    const a = indexFromPoint(base.centers, p.x, p.y);
    const b = indexFromPoint(base.centers, p.x, p.y);
    expect(a).toBe(b);
  });
});

describe('neighborsAt', () => {
  it('reports the ids a drop lands between', () => {
    expect(neighborsAt(['a', 'b', 'c'], 0)).toEqual({ aboveId: undefined, belowId: 'a' });
    expect(neighborsAt(['a', 'b', 'c'], 1)).toEqual({ aboveId: 'a', belowId: 'b' });
    expect(neighborsAt(['a', 'b', 'c'], 3)).toEqual({ aboveId: 'c', belowId: undefined });
  });
});
