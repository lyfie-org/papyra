import { useEffect, type RefObject } from 'react';

/**
 * Reports an element's height whenever it changes, not only when its owner
 * re-renders. The masonry packs cards by their measured heights, and a card's
 * height moves with no render of its own: a web font landing (on a phone's first
 * launch, every card re-wraps when Sora arrives), a thumbnail decoding, a link
 * preview filling in. A height measured once and never revisited leaves cards
 * overlapping or gapped until the page is reloaded.
 */
export function useReportHeight(
  ref: RefObject<HTMLElement | null>,
  id: string,
  onMeasure: (id: string, height: number) => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => onMeasure(id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, id, onMeasure]);
}
