import { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, X } from 'lucide-react';
import { useNotes } from '../../hooks/useNotes';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { openItemCount } from '../../lib/journalText';
import './TodoPicker.css';

/**
 * "Embed a to-do": the to-dos with something still open, searchable, one tap to
 * show one in the page. Escape or the backdrop closes it without choosing.
 */
export default function TodoPicker({ onPick, onClose }: { onPick: (title: string) => void; onClose: () => void }) {
  const { data: notes } = useNotes();
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const todos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (notes ?? [])
      .filter((n) => n.kind === 'todo' && !n.trashed && !n.archived && !n.secure)
      .map((n) => ({ note: n, open: openItemCount(n.body) }))
      .filter((t) => t.open > 0 && (!q || t.note.title.toLowerCase().includes(q)))
      .sort((a, b) => b.note.updated.localeCompare(a.note.updated));
  }, [notes, query]);

  return (
    <div className="todo-picker__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="todo-picker" role="dialog" aria-modal="true" aria-label="Embed a to-do">
        <div className="todo-picker__head">
          <ListChecks size={16} aria-hidden="true" />
          <h2>Embed a to-do</h2>
          <button type="button" className="todo-picker__close" onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button>
        </div>
        <input
          className="todo-picker__search" type="search" value={query} placeholder="Find a list"
          aria-label="Find a to-do list" onChange={(e) => setQuery(e.target.value)} autoFocus
        />
        {todos.length === 0 ? (
          <p className="todo-picker__empty">{query ? 'No list by that name has anything open.' : 'No to-do has anything open.'}</p>
        ) : (
          <ul className="todo-picker__list">
            {todos.map(({ note, open }) => (
              <li key={note.id}>
                <button type="button" className="todo-picker__item" onClick={() => onPick(note.title)}>
                  <span className="todo-picker__title">{note.title || 'Untitled'}</span>
                  <span className="todo-picker__count">{open} open</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
