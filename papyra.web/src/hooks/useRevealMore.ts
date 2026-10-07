import { useCallback, useEffect, useState } from 'react';

// A card row is rarely shorter than this; it only sizes a batch, so erring small
// just means a slightly bigger one.
const ROW_PX = 160;
// Start loading the next batch this far before the end comes into view.
const AHEAD_PX = 800;

/** The nearest ancestor that scrolls, or null for the page itself. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/**
 * Incremental reveal for a long card list: how many of `total` items to mount,
 * starting with what fits on screen plus as much again, growing by that much each
 * time the sentinel (rendered after the last mounted item) nears the viewport.
 *
 * Each growth re-observes the sentinel, so a batch that still leaves it on
 * screen (tall window, short cards) pulls the next one at once.
 */
export function useRevealMore(total: number, cols: number, need = 0) {
  const batch = Math.max(12, cols * (Math.ceil((typeof window === 'undefined' ? 900 : window.innerHeight) / ROW_PX) + 2));
  const [batches, setBatches] = useState(1);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  // `need`: how many must be mounted regardless — "take me to this note" has to
  // find its card even when it sits past the first screenful.
  const shown = Math.min(total, Math.max(batches * batch, need));

  useEffect(() => {
    if (!sentinel || shown >= total || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setBatches(b => b + 1); },
      { root: scrollParent(sentinel), rootMargin: `0px 0px ${AHEAD_PX}px 0px` },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, shown, total]);

  const sentinelRef = useCallback((el: HTMLElement | null) => setSentinel(el), []);
  return { shown, sentinelRef };
}
