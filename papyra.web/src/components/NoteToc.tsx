import { useEffect, useRef, useState } from 'react';
import './NoteToc.css';

interface Head {
  key: number;
  text: string;
  level: number;
  top: number;   // offsetTop within the scroll container
  ratio: number; // top / scrollHeight → position on the ghost bar
}

// Auto table-of-contents "ghost scrollbar": a thin rail down the editor's right
// edge with a tick per heading, positioned at the heading's relative scroll depth.
// Hovering expands it (CSS) into a clickable mini-map; a click smooth-scrolls the
// editor to that heading. Headings are read from the live DOM (Luthor renders real
// h1/h2/h3), re-scanned as the body changes.
export default function NoteToc({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const [heads, setHeads] = useState<Head[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const scan = () => {
      const nodes = Array.from(el.querySelectorAll('h1, h2, h3')) as HTMLElement[];
      const sh = el.scrollHeight || 1;
      // Position within the scroll content, independent of offsetParent nesting
      // (Luthor wraps the body in its own positioned container, so offsetTop lies).
      const base = el.getBoundingClientRect().top - el.scrollTop;
      setHeads(nodes.map((h, i) => {
        const top = h.getBoundingClientRect().top - base;
        return {
          key: i,
          text: (h.textContent ?? '').trim(),
          level: Number(h.tagName[1]),
          top,
          ratio: Math.min(1, Math.max(0, top / sh)),
        };
      }).filter((h) => h.text.length > 0));
    };

    // Debounce rescans on a timer — a contenteditable fires many mutations, and
    // setTimeout (unlike rAF) still runs when the tab isn't in the foreground.
    const schedule = () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(scan, 100);
    };

    scan();
    // The editor mounts with plain text, then parses markdown into headings a tick
    // later — rescan once after paint so the first render isn't missed.
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

  // The rail only earns its space once a note has real structure.
  if (heads.length < 2) return null;

  const jump = (top: number) =>
    scrollRef.current?.scrollTo({ top: Math.max(0, top - 16), behavior: 'smooth' });

  return (
    <nav className="note-toc" aria-label="Table of contents">
      <div className="note-toc__bar">
        {heads.map((h) => (
          <button
            key={h.key}
            type="button"
            className={`note-toc__tick note-toc__tick--h${h.level}`}
            style={{ top: `${h.ratio * 100}%` }}
            onClick={() => jump(h.top)}
          >
            <span className="note-toc__dash" aria-hidden="true" />
            <span className="note-toc__label">{h.text}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
