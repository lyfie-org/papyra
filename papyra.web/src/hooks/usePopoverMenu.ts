import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Room kept between the menu and the window edge.
const EDGE = 8;

function stop(e: React.SyntheticEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * The mechanics of a "…" menu on a card: portalled and placed against the
 * window (below the button when there's room, above when there isn't, kept
 * inside the window sideways), closed by a click elsewhere, Escape, a scroll or
 * a resize; the first item focused on open and the arrow keys moving between
 * items.
 */
export function usePopoverMenu() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => { setOpen(false); setPos(null); }, []);

  // Place after the menu has rendered (hidden) so its real size is known.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!t || !m) return;
      const { offsetWidth: w, offsetHeight: h } = m;
      const below = t.bottom + 4;
      const above = t.top - 4 - h;
      const top = below + h <= window.innerHeight - EDGE || above < EDGE
        ? Math.min(below, window.innerHeight - EDGE - h)
        : above;
      const left = Math.min(Math.max(EDGE, t.right - w), window.innerWidth - EDGE - w);
      setPos({ top: Math.max(EDGE, top), left });
    };
    place();
    // A menu pinned to a point on screen has to go when that point moves.
    const onMove = () => close();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close]);

  // Outside click / Escape. Capture, so a click on a card that stops
  // propagation still counts as "outside".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Focus the first item on open, for keyboard users; arrows move between items.
  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, pos]);

  const onMenuKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }, []);

  /** A menu item's click: close the menu, then do it. */
  const run = useCallback((fn: () => unknown) => (e: React.MouseEvent) => { stop(e); close(); void fn(); }, [close]);

  const toggle = useCallback((e: React.MouseEvent) => { stop(e); if (open) close(); else setOpen(true); }, [open, close]);

  return { open, pos, triggerRef, menuRef, close, toggle, onMenuKey, run };
}
