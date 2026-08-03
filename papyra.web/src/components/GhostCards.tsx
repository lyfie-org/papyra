import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import './GhostCards.css';

interface Backlink {
  noteId: string;
  title: string;
  snippet: string;
  color: string | null;
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

  return (
    <section className="ghost-cards" aria-label="Linked mentions">
      <h2 className="ghost-cards__head">
        <Link2 size={15} /> Linked Mentions
        <span className="ghost-cards__count">{backlinks.length}</span>
      </h2>
      <ul className="ghost-cards__list">
        {backlinks.map((b) => (
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
  );
}
