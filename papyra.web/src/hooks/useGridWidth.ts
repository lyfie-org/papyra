import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { columnsFor } from '../lib/noteGridLayout';

// Quiet time after the last resize before the grid re-balances its columns.
// Longer than useFlipPosition's settle window, so the re-balance glides.
const SETTLE_MS = 240;

/**
 * Width tracking for the masonry grids, built for a smooth window resize.
 *
 * - Lays out inside the ResizeObserver callback (flushSync), i.e. before the
 *   browser paints: cards take their new width in the same frame the window
 *   does, rather than one frame behind it.
 * - While the column count holds, cards keep the column they're in (`sticky`,
 *   fed to pack's `prefer`). Otherwise every frame's re-wrap would re-pack and
 *   hop cards across the grid. Once the resize stops for SETTLE_MS the grid
 *   re-balances once, and any card that changes column glides there.
 * - `resizedAt` stamps each width change so useFlipPosition can tell a resize
 *   re-flow (snap) from a real layout change (glide).
 *
 * The grid must hand its latest column assignment back via `recordColumns`
 * (from a layout effect). `mounted` says whether the wrapper is rendered yet: a
 * grid with nothing to show renders a placeholder, and must start observing
 * once cards arrive.
 */
export function useGridWidth(wrapRef: RefObject<HTMLElement | null>, mounted = true) {
  const [width, setWidth] = useState(0);
  const [, setSettled] = useState(0);
  const resizedAt = useRef(0);
  const sticky = useRef<Map<string, number> | null>(null);
  const lastColumns = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let current = el.clientWidth;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      if (w === current) return;
      const sameCols = current > 0 && columnsFor(w).cols === columnsFor(current).cols;
      current = w;
      sticky.current = sameCols ? lastColumns.current : null;
      resizedAt.current = performance.now();
      clearTimeout(settle);
      settle = setTimeout(() => {
        sticky.current = null;
        setSettled((t) => t + 1);
      }, SETTLE_MS);
      flushSync(() => setWidth(w));
    });
    ro.observe(el);
    setWidth(current);
    return () => { ro.disconnect(); clearTimeout(settle); };
  }, [wrapRef, mounted]);

  const recordColumns = useCallback((columns: Map<string, number>) => { lastColumns.current = columns; }, []);

  return { width, resizedAt, sticky, recordColumns };
}
