import { useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { originState } from '../lib/noteLink';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';

// Matches a markdown task line: leading bullet, [ ] or [x], then the label.
const CHECK = /^(\s*[-*+]\s+)\[([ xX])\]\s?(.*)$/;

interface TodoItem { line: number; checked: boolean; text: string }

function parse(body: string): { lines: string[]; items: TodoItem[] } {
  const lines = body.split('\n');
  const items: TodoItem[] = [];
  lines.forEach((line, i) => {
    const m = CHECK.exec(line);
    if (m) items.push({ line: i, checked: m[2].toLowerCase() === 'x', text: m[3] });
  });
  return { lines, items };
}

function stop(e: React.MouseEvent) { e.preventDefault(); e.stopPropagation(); }

// A todo note rendered as an interactive checklist. Toggling an item rewrites the
// `- [ ]`/`- [x]` marker in the body and PUTs the whole note (kind preserved).
export default function TodoCard({ note }: { note: Note }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const { lines, items } = parse(note.body);
  const done = items.filter(i => i.checked).length;

  const title = note.title.trim() || 'Untitled';
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const className = `note-card todo-card${note.color ? ' note-card--colored' : ''}`;

  async function putBody(body: string) {
    // Ticking a checkbox is the most likely thing to happen away from a network
    // (shopping list in a basement supermarket), so it goes through the outbox.
    await putNote(note.id, {
      title: note.title, tags: note.tags, color: note.color,
      pinned: note.pinned, archived: note.archived, kind: 'todo', body,
    }, note.updated);
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  function toggle(line: number) {
    const m = CHECK.exec(lines[line]);
    if (!m) return;
    const next = [...lines];
    next[line] = `${m[1]}[${m[2].toLowerCase() === 'x' ? ' ' : 'x'}] ${m[3]}`;
    void putBody(next.join('\n'));
  }

  function addItem() {
    const text = draft.trim();
    if (!text) return;
    const body = note.body.trim() ? `${note.body.replace(/\s+$/, '')}\n- [ ] ${text}` : `- [ ] ${text}`;
    setDraft('');
    void putBody(body);
  }

  return (
    <article className={className} style={style}>
      <Link to={`/note/${encodeURIComponent(note.id)}`} state={originState(location)} className="todo-card__title-link">
        <h3 className="note-card__title">{title}</h3>
      </Link>

      {items.length > 0 && (
        <span className="todo-card__progress">{done}/{items.length} done</span>
      )}

      <ul className="todo-card__list">
        {items.map(item => (
          <li key={item.line} className={`todo-card__item${item.checked ? ' is-done' : ''}`}>
            <button
              type="button"
              role="checkbox"
              aria-checked={item.checked}
              className="todo-card__check"
              onClick={(e) => { stop(e); toggle(item.line); }}
            >
              {item.checked ? '✓' : ''}
            </button>
            <span className="todo-card__text">{item.text || '—'}</span>
          </li>
        ))}
      </ul>

      <div className="todo-card__add">
        <input
          className="todo-card__add-input"
          placeholder="Add item…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
        />
        <button type="button" className="todo-card__add-btn" aria-label="Add item" onClick={addItem}>
          <Plus size={16} />
        </button>
      </div>
    </article>
  );
}
