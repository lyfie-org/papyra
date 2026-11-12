import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n/store';
import type { Area } from '../lib/settingsAreas';
import './SettingsAreaTabs.css';

const AREAS: Area[] = ['you', 'server'];
const PANEL_ID = 'settings-area-panel';
const tabId = (a: Area) => `settings-area-tab-${a}`;

/**
 * Administrators only: Personal, or Administration (what changes things for everyone on this server). One card: two
 * equal tabs as its header, the area's pages beneath them. A real tab pattern: arrow keys move between the tabs, Home
 * and End jump, and the page reads the choice from the address so a reload or a shared link lands in the same place.
 * Everyone else never sees this.
 *
 * The tabs share the width equally and never grow past it: a long label (another language, a bigger font) is cut
 * with an ellipsis rather than pushing a tab out of the card.
 */
export default function SettingsAreaTabs({ area, onChange, children }: { area: Area; onChange: (next: Area) => void; children: ReactNode }) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const at = AREAS.indexOf(area);
    const to = e.key === 'ArrowRight' ? (at + 1) % AREAS.length
      : e.key === 'ArrowLeft' ? (at + AREAS.length - 1) % AREAS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? AREAS.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(AREAS[to]);
    listRef.current?.querySelector<HTMLElement>(`#${tabId(AREAS[to])}`)?.focus();
  }

  return (
    <div className="area-tabs">
      <div ref={listRef} className="area-tabs__list" role="tablist" aria-label={t('settings.area.label')} onKeyDown={onKeyDown}>
        {AREAS.map(a => {
          const selected = a === area;
          const label = t(a === 'server' ? 'settings.area.server' : 'settings.area.you');
          return (
            <button
              key={a}
              id={tabId(a)}
              type="button"
              role="tab"
              className={`area-tabs__tab${selected ? ' is-selected' : ''}`}
              aria-selected={selected}
              aria-controls={PANEL_ID}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(a)}
            >
              <span className="area-tabs__label">{label}</span>
            </button>
          );
        })}
      </div>
      <div id={PANEL_ID} className="area-tabs__sheet" role="tabpanel" aria-labelledby={tabId(area)}>
        {children}
      </div>
    </div>
  );
}
