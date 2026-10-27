import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, FileText, ListChecks, ListPlus } from 'lucide-react';
import { useNotes } from '../../hooks/useNotes';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useToast } from '../../lib/toastContext';
import { useBridgeAttached, useBridgeDraft, type JournalBridge } from '../../lib/journalBridge';
import { isDay, longDate, shortDate } from '../../lib/journalDay';
import { linkTargets } from '../../lib/linkedNotes';
import { openItemCount } from '../../lib/journalText';
import BusyButton from '../BusyButton';
import OnThisDay from './OnThisDay';
import type { Note } from '../../types/note';
import './JournalAside.css';

const SHOWN = 6;


interface Props {
  bridge: JournalBridge;
  /** The day on the page (a carry-over lands here). */
  date: string;
  /** Writing is possible: not a future day, not in the Trash. */
  writable: boolean;
}

/**
 * Beside the page: the things a day usually points at. To-dos with something
 * still open, the notes touched most recently — one tap puts a `[[link]]` in the
 * page — and what today has already linked to. "Bring forward" copies the
 * unticked items of the last day that had any.
 */
export default function JournalAside({ bridge, date, writable }: Props) {
  const { data: notes } = useNotes();
  const draft = useBridgeDraft(bridge);
  const attached = useBridgeAttached(bridge);
  const { toast } = useToast();
  const wide = useMediaQuery('(min-width: 1100px)');
  const [openNarrow, setOpenNarrow] = useState(false);

  const live = useMemo(
    () => (notes ?? []).filter((n) => !n.trashed && !n.archived && !n.secure && n.kind !== 'inbox'),
    [notes],
  );
  const todos = useMemo(
    () => live.filter((n) => n.kind === 'todo')
      .map((n) => ({ note: n, open: openItemCount(n.body) }))
      .filter((t) => t.open > 0)
      .sort((a, b) => b.note.updated.localeCompare(a.note.updated)),
    [live],
  );
  const recent = useMemo(
    () => live.filter((n) => n.kind === 'note').sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, SHOWN),
    [live],
  );

  // What the page links to, resolved the way the editor resolves a link.
  const linked = useMemo(() => {
    const byTitle = new Map<string, Note>();
    for (const n of live) { const t = n.title.trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, n); }
    return linkTargets(draft).map((target) => {
      if (isDay(target)) return { key: target, label: shortDate(target), to: `/journal/${target}`, day: true };
      const hit = byTitle.get(target.toLowerCase());
      return hit ? { key: hit.id, label: hit.title || 'Untitled', to: `/note/${encodeURIComponent(hit.id)}`, day: false } : null;
    }).filter((x): x is { key: string; label: string; to: string; day: boolean } => x !== null);
  }, [draft, live]);
  // To-dos already shown live in the page: `![[Title#^checklist]]`.
  const embeddedTodos = useMemo(
    () => new Set([...draft.matchAll(/!\[\[([^\]#|]+)#\^checklist\]\]/g)].map((m) => m[1].trim().toLowerCase())),
    [draft],
  );
  const linkedTitles = useMemo(() => new Set(linkTargets(draft).map((t) => t.toLowerCase())), [draft]);

  async function bringForward() {
    const carried = await bridge.carryOver();
    toast(carried > 0
      ? `Brought forward ${carried} ${carried === 1 ? 'item' : 'items'}.`
      : 'Nothing left open to bring forward.');
  }

  const canLink = attached && writable;
  const row = (n: Note, extra?: string) => {
    const done = linkedTitles.has(n.title.trim().toLowerCase());
    const embedded = embeddedTodos.has(n.title.trim().toLowerCase());
    return (
      <li key={n.id} className="journal-aside__row">
        <Link to={`/note/${encodeURIComponent(n.id)}`} className="journal-aside__title" title={n.title}>{n.title || 'Untitled'}</Link>
        {extra && <span className="journal-aside__count">{extra}</span>}
        <button
          type="button" className="journal-aside__link" disabled={!canLink || done}
          onClick={() => bridge.insertLink(n.title)}
          aria-label={`${done ? 'Linked' : 'Link'} ${n.title || 'Untitled'}`}
        >{done ? 'Linked' : 'Link'}</button>
        {n.kind === 'todo' && (
          <button
            type="button" className="journal-aside__link" disabled={!canLink || embedded}
            onClick={() => bridge.insertTodo(n.title)}
            title="Show this list here, with boxes you can tick"
            aria-label={`${embedded ? 'Embedded' : 'Embed'} ${n.title || 'Untitled'}`}
          >{embedded ? 'Embedded' : 'Embed'}</button>
        )}
      </li>
    );
  };

  const body = (
    <>
      <section aria-label="Open to-dos" className="journal-aside__section">
        <h2 className="journal-aside__head"><ListChecks size={14} aria-hidden="true" /> Open to-dos</h2>
        {todos.length === 0 ? (
          <p className="journal-aside__empty">Nothing left open.</p>
        ) : (
          <ul className="journal-aside__list">
            {todos.slice(0, SHOWN).map((t) => row(t.note, `${t.open} open`))}
          </ul>
        )}
        {todos.length > SHOWN && <Link to="/todo" className="journal-aside__more">All {todos.length} lists</Link>}
        <BusyButton
          type="button" className="journal-aside__carry" disabled={!canLink} busyLabel="Bringing forward…"
          onClick={bringForward} title="Copy the unticked items of the last day that had any into this day"
        ><ListPlus size={14} aria-hidden="true" /> Bring forward</BusyButton>
      </section>

      <section aria-label="Recent notes" className="journal-aside__section">
        <h2 className="journal-aside__head"><FileText size={14} aria-hidden="true" /> Recent notes</h2>
        {recent.length === 0
          ? <p className="journal-aside__empty">No notes yet.</p>
          : <ul className="journal-aside__list">{recent.map((n) => row(n))}</ul>}
      </section>

      <OnThisDay date={date} />

      <section aria-label={`Linked on ${longDate(date)}`} className="journal-aside__section">
        <h2 className="journal-aside__head"><BookOpen size={14} aria-hidden="true" /> Linked today</h2>
        {linked.length === 0 ? (
          <p className="journal-aside__empty">Links you write here collect below.</p>
        ) : (
          <ul className="journal-aside__chips">
            {linked.map((l) => (
              <li key={l.key}><Link to={l.to} className={`journal-aside__chip${l.day ? ' journal-aside__chip--day' : ''}`}>{l.label}</Link></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );

  return (
    <aside className="journal-aside" aria-label="Link a note or to-do">
      {wide ? body : (
        <details open={openNarrow} onToggle={(e) => setOpenNarrow((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="journal-aside__summary">Link a note or to-do</summary>
          {openNarrow && body}
        </details>
      )}
    </aside>
  );
}
