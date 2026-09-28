import { memo, useId, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pin, Plus, Share2, Trash2, X } from 'lucide-react';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';
import { patchNoteInCache } from '../lib/notesCache';
import { useTrashNote } from '../hooks/useTrashNote';
import { useSyncState } from '../hooks/useSync';
import CardMenu from './CardMenu';
import ShareDialog from './ShareDialog';
import { InlineMarkdown } from './MarkdownPreview';
import { tintInkClass } from '../lib/noteColors';
import { useResolvedTheme } from '../hooks/useTheme';

// Matches a markdown task line: leading bullet, [ ] or [x], then the label.
const CHECK = /^(\s*[-*+]\s+)\[([ xX])\]\s?(.*)$/;

interface TodoItem { line: number; checked: boolean; text: string; depth: number }

function parse(body: string): { lines: string[]; items: TodoItem[] } {
  const lines = body.split('\n');
  const items: TodoItem[] = [];
  lines.forEach((line, i) => {
    const m = CHECK.exec(line);
    // Nesting as the editor writes it: 4 spaces (or a tab) per level.
    if (m) items.push({ line: i, checked: m[2].toLowerCase() === 'x', text: m[3], depth: Math.floor(m[1].replace(/\t/g, '    ').search(/\S/) / 4) });
  });
  return { lines, items };
}

function stop(e: React.MouseEvent) { e.preventDefault(); e.stopPropagation(); }

// A todo note rendered as an interactive checklist. Toggling an item rewrites the
// `- [ ]`/`- [x]` marker in the body and PUTs the whole note (kind preserved).
function TodoCard({ note }: { note: Note }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const trashNote = useTrashNote();
  const navigate = useNavigate();
  const { online } = useSyncState();
  const offlineHint = online ? undefined : 'Needs a connection';
  const idBase = useId();
  const { lines, items } = parse(note.body);
  const done = items.filter(i => i.checked).length;

  const title = note.title.trim() || 'Untitled';
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const theme = useResolvedTheme();
  const className = `note-card todo-card${note.color ? ` note-card--colored${tintInkClass(note.color, theme)}` : ''}`;

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

  // Remove one item's line (children it had simply move up a level).
  function removeItem(line: number) {
    const next = lines.filter((_, i) => i !== line);
    void putBody(next.join('\n'));
  }

  async function togglePin() {
    const pinned = !note.pinned;
    patchNoteInCache(queryClient, note.id, { pinned });
    await putNote(note.id, {
      title: note.title, tags: note.tags, color: note.color,
      pinned, archived: note.archived, kind: 'todo', body: note.body,
    }, note.updated);
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  // The whole card opens the list, like a note card — except the things on it
  // that do something themselves (a checkbox, the add field, the action rail).
  function openFromCard(e: React.MouseEvent) {
    if (e.defaultPrevented) return;
    if ((e.target as Element).closest('button, input, textarea, a, [role="menu"]')) return;
    if (window.getSelection()?.toString()) return; // selecting text isn't a click
    navigate(`/note/${encodeURIComponent(note.id)}`);
  }

  async function archive() {
    patchNoteInCache(queryClient, note.id, { archived: true });
    await putNote(note.id, {
      title: note.title, tags: note.tags, color: note.color,
      pinned: note.pinned, archived: true, kind: 'todo', body: note.body,
    }, note.updated);
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  function addItem() {
    const text = draft.trim();
    if (!text) return;
    const body = note.body.trim() ? `${note.body.replace(/\s+$/, '')}\n- [ ] ${text}` : `- [ ] ${text}`;
    setDraft('');
    void putBody(body);
  }

  return (
    <article className={className} style={style} onClick={openFromCard}>
      {/* The same corner pin as a note card: shown on hover, always when pinned. */}
      <button
        type="button"
        className={`note-card__pin${note.pinned ? ' note-card__pin--active' : ''}`}
        aria-pressed={note.pinned}
        aria-label={note.pinned ? 'Unpin list' : 'Pin list'}
        onClick={(e) => { stop(e); void togglePin(); }}
      >
        <Pin size={15} fill={note.pinned ? 'currentColor' : 'none'} />
      </button>
      <Link to={`/note/${encodeURIComponent(note.id)}`} className="todo-card__title-link">
        <h3 className="note-card__title">{title}</h3>
      </Link>

      {items.length > 0 && (
        <span className="todo-card__progress">{done}/{items.length} done</span>
      )}

      <ul className="todo-card__list">
        {items.map(item => (
          <li
            key={item.line}
            className={`todo-card__item${item.checked ? ' is-done' : ''}`}
            style={item.depth ? { paddingLeft: `${Math.min(item.depth, 3) * 1.4}em` } : undefined}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={item.checked}
              // Named by the item's own text, so a screen reader says what is
              // being ticked rather than an unlabelled "checkbox".
              aria-labelledby={`${idBase}-item-${item.line}`}
              className="todo-card__check"
              onClick={(e) => { stop(e); toggle(item.line); }}
            >
              <span aria-hidden="true">{item.checked ? '✓' : ''}</span>
            </button>
            <span className="todo-card__text" id={`${idBase}-item-${item.line}`}>{item.text ? <InlineMarkdown text={item.text} /> : '—'}</span>
            <button
              type="button"
              className="todo-card__remove"
              aria-label={`Remove “${item.text || 'empty item'}”`}
              title="Remove item"
              onClick={(e) => { stop(e); removeItem(item.line); }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {/* The + leads, so the hover action rail (bottom-right) never sits on it. */}
      <div className="todo-card__add">
        <button type="button" className="todo-card__add-btn" aria-label="Add item" onClick={addItem}>
          <Plus size={16} />
        </button>
        <input
          className="todo-card__add-input"
          placeholder="Add item…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
        />
      </div>

      {/* The same hover actions a note card has — to-do lists used to have none. */}
      <div className="note-card__actions">
        <button
          type="button" className="note-card__action" aria-label="Archive list"
          onClick={(e) => { stop(e); void archive(); }}
        >
          <Archive size={16} />
        </button>
        <button
          type="button" className="note-card__action" aria-label="Share list"
          disabled={!online} title={offlineHint}
          onClick={(e) => { stop(e); setShareOpen(true); }}
        >
          <Share2 size={16} />
        </button>
        <button
          type="button" className="note-card__action note-card__action--danger" aria-label="Delete list"
          disabled={!online} title={offlineHint}
          onClick={(e) => { stop(e); void trashNote(note); }}
        >
          <Trash2 size={16} />
        </button>
        <CardMenu note={note} onShare={() => setShareOpen(true)} />
      </div>
      {shareOpen && <ShareDialog note={note} onClose={() => setShareOpen(false)} />}
    </article>
  );
}

// Memoised: the desk renders hundreds of these, and a card only needs to redraw
// when its own note changes — not when a sibling is recoloured or pinned.
export default memo(TodoCard);
