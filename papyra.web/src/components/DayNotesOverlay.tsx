import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { Note } from '../types/note';
import { snippet } from '../lib/plainText';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './DayNotesOverlay.css';

/** "12 March 2026", in the reader's own locale. */
function readableDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/**
 * What you wrote on one day, over the page rather than instead of it.
 *
 * Picking a square on the heatmap used to filter the whole notes desk, which
 * meant losing your place to answer a passing question. This is an overlay: it
 * changes no route and no filter, Escape closes it, and the page underneath is
 * exactly where it was.
 */
export default function DayNotesOverlay({
  day, notes, onClose,
}: {
  day: string;
  notes: Note[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="day-notes__scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="day-notes"
        role="dialog"
        aria-modal="true"
        aria-labelledby="day-notes-title"
        ref={panel}
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="day-notes__head">
          <div>
            <h2 id="day-notes-title" className="day-notes__title">{readableDay(day)}</h2>
            <p className="day-notes__count">
              {notes.length === 0
                ? 'Nothing was touched on this day.'
                : `${notes.length} note${notes.length === 1 ? '' : 's'} last changed on this day.`}
            </p>
          </div>
          <button type="button" className="day-notes__close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <ul className="day-notes__list">
          {notes.map(note => (
            <li key={note.id}>
              {/* Opening a note IS a navigation — the difference is that the
                  person asked for it, rather than it happening because they
                  glanced at a square. */}
              <Link className="day-notes__item" to={`/note/${encodeURIComponent(note.id)}`} onClick={onClose}>
                <span className="day-notes__item-title">{note.title.trim() || 'Untitled'}</span>
                {note.secure
                  ? <span className="day-notes__item-snippet">Locked note</span>
                  : note.body.trim() && (
                    <span className="day-notes__item-snippet">{snippet(note.body)}</span>
                  )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
