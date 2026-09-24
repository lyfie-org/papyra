import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pack, columnsFor } from '../lib/noteGridLayout';
import './MasonryGrid.css';

interface Item {
  id: string;
  node: ReactNode;
}

// One absolutely-placed cell. Watches its own height: a to-do card grows when an
// item is added and shrinks when one is removed without the grid re-rendering,
// so a render-time measurement alone would leave the column overlapping.
function Cell({ id, x, y, width, onMeasure, children }: {
  id: string; x: number; y: number; width: number;
  onMeasure: (id: string, h: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(id, el.offsetHeight);
    const ro = new ResizeObserver(() => onMeasure(id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onMeasure]);

  return (
    <div
      ref={ref}
      className="masonry-grid__cell"
      style={{ width, transform: `translate3d(${x}px, ${y}px, 0)` }}
    >
      {children}
    </div>
  );
}

/**
 * Shortest-column masonry, laid out exactly like the Notes desk: the same column
 * count for the container width and the same packing (see noteGridLayout), just
 * without drag-to-reorder. A CSS grid lines cards up in rows, so one long card
 * pushes its whole row down and leaves holes beside the shorter ones.
 */
export default function MasonryGrid({ items }: { items: Item[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const heights = useRef<Map<string, number>>(new Map());
  const [, forceTick] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const onMeasure = useCallback((id: string, h: number) => {
    if (h > 0 && heights.current.get(id) !== h) {
      heights.current.set(id, h);
      forceTick((t) => t + 1);
    }
  }, []);

  const { cols, colW } = columnsFor(width);
  const placed = pack(items.map((i) => i.id), heights.current, cols, colW);

  return (
    <div ref={wrapRef} className="masonry-grid" style={{ height: Math.max(0, placed.height) }}>
      {width > 0 && items.map((item) => {
        const box = placed.boxes.get(item.id);
        return (
          <Cell key={item.id} id={item.id} x={box?.x ?? 0} y={box?.y ?? 0} width={colW} onMeasure={onMeasure}>
            {item.node}
          </Cell>
        );
      })}
    </div>
  );
}
