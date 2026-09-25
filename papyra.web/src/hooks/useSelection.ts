import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nextSelection } from '../lib/bulk';

/**
 * Multi-select over a grid of cards, in display order.
 *
 * - Selecting is a mode: it starts with the first tick and ends when nothing is
 *   selected (Esc, the ✕, or unticking the last card).
 * - Shift+click extends from the last card clicked, like a file manager.
 * - Ctrl/Cmd+A selects everything visible while in the mode; outside it the
 *   browser's own select-all is left alone.
 * - A note that leaves the grid (deleted elsewhere, filtered out) leaves the
 *   selection with it — actions only ever see ids that are on screen.
 */
export function useSelection(ordered: string[]) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const visible = useMemo(() => new Set(ordered), [ordered]);
  // Derived, so a vanished note can never be acted on — no effect-driven sync.
  const selected = useMemo(() => {
    const live = new Set<string>();
    for (const id of picked) if (visible.has(id)) live.add(id);
    return live.size === picked.size ? picked : live;
  }, [picked, visible]);
  const active = selected.size > 0;

  const toggle = useCallback((id: string, shift = false) => {
    // Read the anchor now: the updater runs later, after it has moved to `id`.
    const from = anchor.current;
    setPicked((cur) => {
      const live = new Set([...cur].filter((x) => visible.has(x)));
      return nextSelection(live, ordered, live.size ? from : null, id, shift);
    });
    anchor.current = id;
  }, [ordered, visible]);

  const clear = useCallback(() => { setPicked(new Set()); anchor.current = null; }, []);
  const selectAll = useCallback(() => setPicked(new Set(ordered)), [ordered]);
  const set = useCallback((ids: Iterable<string>) => setPicked(new Set(ids)), []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      // A dialog opened from the bar (share) owns its own Escape.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === 'Escape') { e.preventDefault(); clear(); }
      else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, clear, selectAll]);

  return { selected, active, toggle, clear, selectAll, set };
}
