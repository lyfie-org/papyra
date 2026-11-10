import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import './ServiceTabs.css';

export type ServiceTone = 'on' | 'idle' | 'attention' | 'off';

export interface ServiceTabItem {
  /** Stable id, also what goes in the address (`?service=telegram`). */
  id: string;
  name: string;
  /** The service's mark (see ServiceMark). Decorative: the name says it. */
  mark: ReactNode;
  /** Where the service stands, in words ("Connected", "Not set up"). Part of the tab's name, so it is heard too. */
  chip: string;
  /** Drives the dot beside the chip. The words carry the meaning; the dot only echoes it. */
  tone: ServiceTone;
}

/**
 * A row of service tiles, one per service, and the panel of whichever is chosen. A real tab pattern:
 * `tablist` / `tab` / `tabpanel`; Left and Right move (and choose), Home and End jump to the ends, and only the
 * chosen tab is in the Tab order, so the row is one stop. The choice belongs to the caller (it lives in the
 * address, so a link or a reload lands on the same service).
 */
export default function ServiceTabs({ label, items, value, onChange, children }: {
  label: string;
  items: ServiceTabItem[];
  value: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  const uid = useId();
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = items.find(i => i.id === value) ?? items[0];

  // On a phone the row scrolls sideways. Bring the chosen tile into view only if part of it is hidden (the row
  // only; the page does not move), so a row that fits is never shifted.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const edge = 8;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    let to: number | null = null;
    if (left < list.scrollLeft) to = left - edge;
    else if (right > list.scrollLeft + list.clientWidth) to = right - list.clientWidth + edge;
    if (to === null) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ left: Math.max(0, to), behavior: calm ? 'auto' : 'smooth' });
  }, [current?.id]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const at = items.findIndex(i => i.id === current?.id);
    const to = e.key === 'ArrowRight' ? (at + 1) % items.length
      : e.key === 'ArrowLeft' ? (at - 1 + items.length) % items.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = items[to];
    onChange(next.id);
    tabs.current.get(next.id)?.focus();
  }

  if (!current) return null;
  return (
    <div className="service-tabs">
      <div ref={listRef} className="service-tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map(item => {
          const selected = item.id === current.id;
          return (
            <button
              key={item.id}
              ref={el => { if (el) tabs.current.set(item.id, el); else tabs.current.delete(item.id); }}
              type="button"
              role="tab"
              id={`${uid}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${uid}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              className={`service-tab${selected ? ' is-selected' : ''}`}
              data-tone={item.tone}
              onClick={() => onChange(item.id)}
            >
              <span className="service-tab__mark">{item.mark}</span>
              <span className="service-tab__name">{item.name}</span>
              <span className="service-tab__chip">{item.chip}</span>
            </button>
          );
        })}
      </div>
      <div
        className="service-tabs__panel"
        role="tabpanel"
        id={`${uid}-panel-${current.id}`}
        aria-labelledby={`${uid}-tab-${current.id}`}
      >
        {children}
      </div>
    </div>
  );
}
