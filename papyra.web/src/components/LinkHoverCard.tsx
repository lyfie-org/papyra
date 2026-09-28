import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LinkCard } from './LinkCards';
import './LinkCards.css';

const SHOW_MS = 450;
const HIDE_MS = 220;
const WIDTH = 340;

/**
 * Hovering a web link in the note body shows its preview card beside it, after
 * a short pause (so passing the pointer over text doesn't flicker cards). The
 * editor's own link tools (edit, remove) are untouched — they open on click;
 * this is a look, not an action.
 */
export default function LinkHoverCard({ within }: { within: RefObject<HTMLElement | null> }) {
  const [hover, setHover] = useState<{ url: string; top: number; left: number; above: boolean } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const root = within.current;
    if (!root) return;

    const onOver = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !root.contains(a) || !/^https?:\/\//i.test(a.href) || !a.closest('.luthor-content-editable')) return;
      clearTimeout(hideTimer.current);
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        const r = a.getBoundingClientRect();
        const above = r.bottom + 180 > window.innerHeight && r.top > 200;
        setHover({
          url: a.href,
          top: above ? r.top - 8 : r.bottom + 8,
          left: Math.min(Math.max(8, r.left), window.innerWidth - WIDTH - 8),
          above,
        });
      }, SHOW_MS);
    };
    const onOut = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.('a[href]');
      if (!a) return;
      clearTimeout(showTimer.current);
      hideTimer.current = setTimeout(() => setHover(null), HIDE_MS);
    };
    const onScroll = () => { clearTimeout(showTimer.current); setHover(null); };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onScroll, true);
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, [within]);

  if (!hover) return null;
  return createPortal(
    <div
      className={`link-hover${hover.above ? ' link-hover--above' : ''}`}
      style={{ top: hover.top, left: hover.left, width: WIDTH }}
      onMouseEnter={() => clearTimeout(hideTimer.current)}
      onMouseLeave={() => { hideTimer.current = setTimeout(() => setHover(null), HIDE_MS); }}
    >
      <LinkCard url={hover.url} />
    </div>,
    document.body,
  );
}
