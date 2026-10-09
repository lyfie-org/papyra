import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
// The rail's vertical padding (matches .note-toc__rail in the CSS).
const RAIL_PAD = 6;
// Extra height the one magnified heading takes while the rail is open.
const GROW = 14;

/**
 * An outline rail down the sheet's right edge, one short dash per heading.
 *
 * At rest it is quiet: evenly spaced dashes (not placed by scroll depth — that
 * bunched them beside the title), the current section's dash longer and sage.
 * Pointing at it opens it: every name shows at one small size, and only the
 * heading under the pointer (or keyboard focus) is magnified. One heading is
 * ever "selected", so the highlight is always the one you are on — a Dock-style
 * swell put a sage "current section" label beside a different, bigger one.
 * Click to jump.
 *
 * The whole rail is one control (an "Outline" listbox, one tab stop): its rows
 * are a few pixels tall, far under the 24px a target needs on its own (WCAG
 * 2.5.8), so the rail is the target and the row under the pointer is the one a
 * click takes you to. From the keyboard: Tab to it, ↑/↓ (Home/End) to pick a
 * heading, Enter to jump, Esc to put it away.
 */
export default function NoteToc({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const [heads, setHeads] = useState<Head[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const [frame, setFrame] = useState({ top: TOP_CLEARANCE, height: 300 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idPrefix = useId();

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
  const open = focused !== null;

  // Which heading the pointer is on, read against the rail as laid out now: the
  // magnified row is GROW taller, so resting slots alone would hand the pointer
  // to a neighbour while it is still over the grown row, and the rail would
  // flicker between the two.
  const headAt = (y: number) => {
    const i = focused ?? -1;
    const index = i >= 0 && y >= i * step
      ? (y < (i + 1) * step + GROW ? i : Math.floor((y - GROW) / step))
      : Math.floor(y / step);
    return Math.max(0, Math.min(heads.length - 1, index));
  };

  const jump = (top: number) =>
    scrollRef.current?.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' });

  // Padding sits above the first row; take it off so y is in row space.
  const rowAt = (e: React.PointerEvent | React.MouseEvent) =>
    headAt(e.clientY - e.currentTarget.getBoundingClientRect().top - RAIL_PAD);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = heads.length - 1;
    const from = focused ?? active;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = Math.min(last, from + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, from - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      jump(heads[from].top);
      return;
    } else if (e.key === 'Escape' && focused !== null) {
      e.preventDefault();
      e.stopPropagation();
      setFocused(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setFocused(next);
    }
  };

  const optionId = (i: number) => `${idPrefix}-toc-${i}`;

  return (
    <nav className="note-toc" aria-label="Outline">
      <div
        className={`note-toc__rail${open ? ' is-open' : ''}`}
        style={{ top: frame.top + Math.max(0, (frame.height - railHeight) / 2) }}
        role="listbox"
        tabIndex={0}
        aria-label="Jump to a heading"
        aria-activedescendant={focused !== null ? optionId(focused) : undefined}
        onPointerMove={(e) => setFocused(rowAt(e))}
        onPointerLeave={(e) => { if (!e.currentTarget.matches(':focus-visible')) setFocused(null); }}
        onClick={(e) => jump(heads[rowAt(e)].top)}
        onFocus={() => setFocused((f) => f ?? active)}
        onBlur={() => setFocused(null)}
        onKeyDown={onKeyDown}
      >
        {heads.map((h, i) => {
          const isFocused = i === focused;
          return (
            <div
              key={h.key}
              id={optionId(i)}
              role="option"
              aria-selected={isFocused}
              aria-current={i === active ? 'location' : undefined}
              className={`note-toc__item note-toc__item--h${h.level}${i === active ? ' is-active' : ''}${isFocused ? ' is-focused' : ''}`}
              style={{ height: step + (isFocused ? GROW : 0) }}
              title={open ? undefined : h.text}
            >
              <span className="note-toc__label">{h.text}</span>
              <span className="note-toc__dash" aria-hidden="true" />
            </div>
          );
        })}
      </div>
    </nav>
  );
}
