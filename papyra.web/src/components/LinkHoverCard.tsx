import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LinkCard } from './LinkCards';
import './LinkCards.css';

const SHOW_MS = 450;
const HIDE_MS = 220;
const WIDTH = 340;
/** Room the preview needs below or above what it belongs to. */
const ROOM = 180;
const GAP = 8;

/** What an embed (web page, video, link card) says it shows: the editor's `data-luthor-embed-url`. */
const EMBED = '[data-luthor-embed-url]';

interface Target {
  url: string;
  element: Element;
}

/**
 * Hovering a web link — or a whole embed: a map, a video, a link card — in the
 * note body shows its preview card beside it, after a short pause (so passing
 * the pointer over text doesn't flicker cards). The preview is itself the link:
 * a click opens the page in a new tab. The editor's own tools are untouched —
 * a click on an embed still selects it, and a selected or moving embed shows
 * no preview (its toolbar is there instead).
 */
export default function LinkHoverCard({ within }: { within: RefObject<HTMLElement | null> }) {
  const [hover, setHover] = useState<{ url: string; top: number; left: number; above: boolean } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<Element | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const root = within.current;
    if (!root) return;

    const targetOf = (node: EventTarget | null): Target | null => {
      const el = node instanceof Element ? node : null;
      const embed = el?.closest(EMBED);
      if (embed && root.contains(embed) && embed.closest('.luthor-content-editable')) {
        const url = embed.getAttribute('data-luthor-embed-url') ?? '';
        return /^https?:\/\//i.test(url) ? { url, element: embed } : null;
      }
      const a = el?.closest('a[href]') as HTMLAnchorElement | null | undefined;
      if (!a || !root.contains(a) || !/^https?:\/\//i.test(a.href) || !a.closest('.luthor-content-editable')) return null;
      return { url: a.href, element: a };
    };
    // Being edited (selected, its toolbar open) or moved: no preview.
    const busy = (el: Element) =>
      !!el.closest('.is-selected, .is-block-dragging') || document.body.classList.contains('luthor-is-block-dragging');

    const place = (el: Element) => {
      const r = el.getBoundingClientRect();
      const left = (x: number) => Math.min(Math.max(8, x), window.innerWidth - WIDTH - 8);
      if (r.bottom + GAP + ROOM <= window.innerHeight) return { top: r.bottom + GAP, left: left(r.left), above: false };
      if (r.top - GAP - ROOM >= 0) return { top: r.top - GAP, left: left(r.left), above: true };
      // A tall embed that fills the view: beside the pointer, inside it.
      const { x, y } = pointer.current;
      const above = y + GAP + ROOM > window.innerHeight;
      return { top: above ? y - GAP : y + GAP * 2, left: left(x - 40), above };
    };

    const hide = () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
      current.current = null;
      setHover(null);
    };

    const onOver = (e: MouseEvent) => {
      const target = targetOf(e.target);
      if (!target || busy(target.element)) return;
      clearTimeout(hideTimer.current);
      // Still within the same link or embed: leave the preview (or its timer) be.
      if (current.current === target.element) return;
      current.current = target.element;
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        if (current.current !== target.element || busy(target.element)) return;
        setHover({ url: target.url, ...place(target.element) });
      }, SHOW_MS);
    };
    const onOut = (e: MouseEvent) => {
      const target = targetOf(e.target);
      if (!target) return;
      // Moving between the parts of one embed is not leaving it.
      if (e.relatedTarget instanceof Node && target.element.contains(e.relatedTarget)) return;
      clearTimeout(showTimer.current);
      hideTimer.current = setTimeout(() => {
        current.current = null;
        setHover(null);
      }, HIDE_MS);
    };
    const onMove = (e: MouseEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('mousemove', onMove, { passive: true });
    // A press selects, drags or types: the preview gets out of the way.
    root.addEventListener('pointerdown', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
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
      onMouseLeave={() => {
        hideTimer.current = setTimeout(() => {
          current.current = null;
          setHover(null);
        }, HIDE_MS);
      }}
    >
      <LinkCard url={hover.url} />
    </div>,
    document.body,
  );
}
