import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './NoteToc.css';

interface Head {
  key: number;
  text: string;
  level: number;
  top: number; // offset within the scroll container's content
}

// Room the rail keeps clear at the top of the sheet (title + tags live there).
const TOP_CLEARANCE = 132;
// Each heading's resting slot, and the most the rail may take up.
const MAX_STEP = 14;
const MIN_STEP = 5;
// How far (px) the "magnification" reaches from the pointer.
const REACH = 84;

/**
 * An outline rail down the sheet's right edge, one short dash per heading.
 *
 * At rest it is quiet: evenly spaced dashes (not placed by scroll depth — that
 * bunched them beside the title), the current section's dash longer and sage.
 * Pointing at it opens it like the macOS Dock: headings near the pointer grow
 * and show their names in full, their neighbours less, the far ones stay small
 * — and the swell follows the pointer up and down. That keeps a note with fifty
 * headings readable without ever printing fifty labels at once. Click to jump.
 */
export default function NoteToc({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const [heads, setHeads] = useState<Head[]>([]);
  const [active, setActive] = useState(0);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const [frame, setFrame] = useState({ top: TOP_CLEARANCE, height: 300 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read headings from the live editor DOM (Luthor renders real h1–h3).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const scan = () => {
      const nodes = Array.from(el.querySelectorAll('.luthor-content-editable :is(h1, h2, h3)')) as HTMLElement[];
      const base = el.getBoundingClientRect().top - el.scrollTop;
      setHeads(nodes.map((h, i) => ({
        key: i,
        text: (h.textContent ?? '').trim(),
        level: Number(h.tagName[1]),
        top: h.getBoundingClientRect().top - base,
      })).filter((h) => h.text.length > 0));
      setFrame({ top: TOP_CLEARANCE, height: Math.max(120, el.clientHeight - TOP_CLEARANCE - 48) });
    };
    const schedule = () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(scan, 120);
    };

    scan();
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, [scrollRef]);

  // Which section the reader is in: the last heading above a line a third of
  // the way down the sheet.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || heads.length === 0) return;
    const onScroll = () => {
      const line = el.scrollTop + el.clientHeight / 3;
      let current = 0;
      for (let i = 0; i < heads.length; i++) if (heads[i].top <= line) current = i;
      setActive(current);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, heads]);

  // The rail only earns its space once a note has real structure.
  if (heads.length < 2) return null;

  const step = Math.max(MIN_STEP, Math.min(MAX_STEP, frame.height / heads.length));
  const railHeight = step * heads.length;
  const open = pointerY !== null;

  const jump = (top: number) =>
    scrollRef.current?.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' });

  return (
    <nav className="note-toc" aria-label="Outline">
      <div
        className={`note-toc__rail${open ? ' is-open' : ''}`}
        style={{ top: frame.top + Math.max(0, (frame.height - railHeight) / 2) }}
        onPointerMove={(e) => setPointerY(e.clientY - e.currentTarget.getBoundingClientRect().top)}
        onPointerLeave={() => setPointerY(null)}
      >
        {heads.map((h, i) => {
          // Distance from the pointer to this heading's resting slot → 0…1.
          const center = i * step + step / 2;
          const boost = open ? Math.max(0, 1 - Math.abs(pointerY! - center) / REACH) : 0;
          const eased = boost * boost * (3 - 2 * boost); // smoothstep: a soft swell
          return (
            <button
              key={h.key}
              type="button"
              className={`note-toc__item note-toc__item--h${h.level}${i === active ? ' is-active' : ''}`}
              style={{
                height: step + (open ? eased * 16 : 0),
                ['--boost' as string]: eased.toFixed(3),
              }}
              onClick={() => jump(h.top)}
              aria-current={i === active ? 'location' : undefined}
              title={open ? undefined : h.text}
            >
              <span className="note-toc__label">{h.text}</span>
              <span className="note-toc__dash" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
