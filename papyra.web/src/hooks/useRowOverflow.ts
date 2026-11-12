import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface RowOverflow {
  /** There is more of the row before / after what is showing. */
  back: boolean;
  forward: boolean;
  /** Scrolls the row to a position, smoothly unless the person asked for reduced motion. */
  scrollTo: (left: number) => void;
  /** Most of a row's width, so the item cut off at the edge comes fully into view and the next ones follow it. */
  page: (direction: 1 | -1) => void;
}

/** The wrapper's class: it holds the arrows, and tells the scroller (`row-scroll__scroller`) which ends to fade. */
export function rowScrollClass({ back, forward }: Pick<RowOverflow, 'back' | 'forward'>) {
  return `row-scroll${back ? ' has-more-back' : ''}${forward ? ' has-more-forward' : ''}`;
}

/**
 * Watches a sideways-scrolling row and says which ends have more. `contentKey` names what is in the row: when it
 * changes, the new children are watched too (a label can load, change or wrap in a bigger font, and that changes what
 * fits).
 */
export function useRowOverflow(ref: RefObject<HTMLElement | null>, contentKey: unknown): RowOverflow {
  const [back, setBack] = useState(false);
  const [forward, setForward] = useState(false);

  const measure = useCallback(() => {
    const row = ref.current;
    if (!row) return;
    // A pixel of slack: scroll positions are fractional on a scaled display, so the far end can stop just short.
    setBack(row.scrollLeft > 1);
    setForward(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  }, [ref]);

  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    let watcher: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      watcher = new ResizeObserver(measure);
      watcher.observe(row);
      for (const child of row.children) watcher.observe(child);
    }
    return () => {
      row.removeEventListener('scroll', measure);
      watcher?.disconnect();
    };
  }, [ref, measure, contentKey]);

  const scrollTo = useCallback((left: number) => {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollTo({ left, behavior: calm ? 'auto' : 'smooth' });
  }, [ref]);

  const page = useCallback((direction: 1 | -1) => {
    const row = ref.current;
    if (row) scrollTo(Math.max(0, row.scrollLeft + direction * Math.round(row.clientWidth * 0.75)));
  }, [ref, scrollTo]);

  return { back, forward, scrollTo, page };
}
