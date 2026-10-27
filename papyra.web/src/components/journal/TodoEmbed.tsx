import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, Lock, Trash2 } from 'lucide-react';
import { useNotes } from '../../hooks/useNotes';
import { useSyncState } from '../../hooks/useSync';
import { useToast } from '../../lib/toastContext';
import { parseChecklist, openCount, type ChecklistItem } from '../../lib/checklist';
import { flattenMarkdown } from '../../lib/plainText';
import type { Note } from '../../types/note';
import './TodoEmbed.css';

interface Props {
  /** The to-do's title (or id), as written in `![[Title#^checklist]]`. */
  note: string;
  status: 'loading' | 'resolved' | 'unresolved';
  /** The checklist the server resolved (its item lines), when resolved. */
  content: string | null;
}

function findTodo(notes: readonly Note[] | undefined, ref: string): Note | undefined {
  if (!notes) return undefined;
  const wanted = ref.trim().toLowerCase();
  return notes.find((n) => n.kind === 'todo' && n.title.trim().toLowerCase() === wanted)
    ?? notes.find((n) => n.kind === 'todo' && n.id.toLowerCase() === wanted);
}

/**
 * A to-do, shown inside a day of the journal — and live. The day's file holds only
 * `![[Groceries#^checklist]]`; the items are drawn from the to-do itself (kept
 * fresh by the same cache every other view reads), and a tick goes to the to-do's
 * own note: one write through the same careful path as any edit, merged into it if
 * someone has it open. Offline it reads, it doesn't tick. A list that moved on since
 * it was drawn refreshes instead of ticking the wrong line.
 */
export default function TodoEmbed({ note, status, content }: Props) {
  const queryClient = useQueryClient();
  const { data: notes } = useNotes();
  const { online } = useSyncState();
  const { toast } = useToast();
  const todo = findTodo(notes, note);
  const live = todo && !todo.secure && !todo.trashed ? todo : undefined;

  // The list as the cache (or, before it loads, the server's resolve) has it, with
  // a tick shown the instant it is made — until the cache catches up with the write.
  const fromCache = useMemo(() => parseChecklist(live ? live.body : content), [live, content]);
  const [local, setLocal] = useState<{ base: string | null; items: ChecklistItem[] } | null>(null);
  const base = live?.body ?? content;
  const items = local && local.base === base ? local.items : fromCache;
  const [busy, setBusy] = useState<number | null>(null);

  if (status === 'loading' && !live) {
    return <div className="todo-embed todo-embed--note" role="note" aria-busy="true">Loading the list…</div>;
  }
  if (!live && (status === 'unresolved' || !content)) {
    const why = todo?.trashed ? { icon: Trash2, text: `“${todo.title}” is in the Trash.`, to: '/trash', link: 'Open the Trash' }
      : todo?.secure ? { icon: Lock, text: `“${todo.title}” is locked.`, to: null, link: null }
        : { icon: ListChecks, text: 'This to-do isn’t available.', to: null, link: null };
    const Icon = why.icon;
    return (
      <div className="todo-embed todo-embed--note" role="note">
        <Icon size={15} aria-hidden="true" /> <span>{why.text}</span>
        {why.to && <Link to={why.to} className="todo-embed__link">{why.link}</Link>}
      </div>
    );
  }

  async function toggle(item: ChecklistItem) {
    if (!live || busy !== null) return;
    const next = !item.checked;
    setLocal({ base, items: items.map((i) => (i.index === item.index ? { ...i, checked: next } : i)) });
    setBusy(item.index);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(live.id)}/checklist/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: item.index, text: item.text, checked: next }),
      });
      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as { items?: ChecklistItem[] } | null;
        if (data?.items) setLocal({ base, items: data.items });
        toast('That list changed — showing it as it is now.');
      } else if (!res.ok) {
        throw new Error(String(res.status));
      } else {
        const data = (await res.json()) as { items: ChecklistItem[] };
        setLocal({ base, items: data.items });
      }
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
    } catch {
      setLocal(null);
      toast('Couldn’t update the to-do.');
    } finally {
      setBusy(null);
    }
  }

  const title = live?.title || todo?.title || note;
  const open = openCount(items);
  return (
    <div className="todo-embed" contentEditable={false} onMouseDown={(e) => e.stopPropagation()}>
      <div className="todo-embed__head">
        <ListChecks size={15} aria-hidden="true" />
        {live ? <Link to={`/note/${encodeURIComponent(live.id)}`} className="todo-embed__title">{title}</Link> : <span className="todo-embed__title">{title}</span>}
        <span className="todo-embed__count">{open === 0 ? 'All done' : `${open} open`}</span>
      </div>
      {items.length === 0 ? (
        <p className="todo-embed__empty">No items in this list yet.</p>
      ) : (
        <ul className="todo-embed__list">
          {items.map((item) => (
            <li key={item.index} className={`todo-embed__item${item.checked ? ' is-done' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled={!live || !online || busy !== null}
                  onChange={() => void toggle(item)}
                />
                <span>{flattenMarkdown(item.text)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!online && <p className="todo-embed__offline" role="status">Offline — you can read this list; ticking waits for the connection.</p>}
    </div>
  );
}
