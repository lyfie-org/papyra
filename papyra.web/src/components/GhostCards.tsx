import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Link2 } from 'lucide-react';
import { shortDate } from '../lib/journalDay';
import './GhostCards.css';

interface Backlink {
  noteId: string;
  title: string;
  snippet: string;
  color: string | null;
  /** Where the reference lives: a note, a to-do, or a day of the journal. */
  kind?: string;
}

// Split a highlighter snippet (plain text with <mark>…</mark> spans) into React
// nodes — never dangerouslySetInnerHTML, so a note's own body can't inject markup.
function renderSnippet(snippet: string) {
  return snippet.split(/(<mark>.*?<\/mark>)/g).map((part, i) => {
    const m = /^<mark>(.*)<\/mark>$/.exec(part);
    return m ? <mark key={i}>{m[1]}</mark> : <span key={i}>{part}</span>;
  });
}

// "Linked Mentions": the notes that reference the open note through a [[Title]]
// wikilink. Translucent, dashed-border ghost cards; clicking opens the source note.
export default function GhostCards({ noteId }: { noteId: string }) {
  const navigate = useNavigate();
  const { data: backlinks } = useQuery<Backlink[]>({
    queryKey: ['backlinks', noteId],
    queryFn: async () => {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/backlinks`);
      if (!res.ok) throw new Error(`GET backlinks failed: ${res.status}`);
      return res.json();
    },
  });

  if (!backlinks || backlinks.length === 0) return null;
  const days = backlinks.filter((b) => b.kind === 'journal').sort((a, b) => b.noteId.localeCompare(a.noteId));
  const notes = backlinks.filter((b) => b.kind !== 'journal');

  return (
    <>
    {notes.length > 0 && (
    <section className="ghost-cards" aria-label="Linked mentions">
      <h2 className="ghost-cards__head">
        <Link2 size={15} /> Linked Mentions
        <span className="ghost-cards__count">{notes.length}</span>
      </h2>
      <ul className="ghost-cards__list">
        {notes.map((b) => (
          <li key={b.noteId}>
            <button
              type="button"
              className="ghost-card"
              style={b.color ? { borderColor: b.color } : undefined}
              onClick={() => navigate(`/note/${encodeURIComponent(b.noteId)}`)}
            >
              <span className="ghost-card__title">{b.title || 'Untitled'}</span>
              <span className="ghost-card__snippet">{renderSnippet(b.snippet)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
    )}
    {days.length > 0 && (
      // Days of the journal that point here — dated chips, newest first.
      <section className="ghost-cards ghost-cards--days" aria-label="In your journal">
        <h2 className="ghost-cards__head">
          <BookOpen size={15} /> In your journal
          <span className="ghost-cards__count">{days.length}</span>
        </h2>
        <ul className="ghost-cards__chips">
          {days.map((b) => {
            const day = b.noteId.replace(/^journal-/, '');
            return (
              <li key={b.noteId}>
                <button type="button" className="ghost-cards__day" onClick={() => navigate(`/journal/${day}`)} title={b.snippet.replace(/<\/?mark>/g, '')}>
                  {shortDate(day)} <span className="ghost-cards__year">{day.slice(0, 4)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    )}
    </>
  );
}
