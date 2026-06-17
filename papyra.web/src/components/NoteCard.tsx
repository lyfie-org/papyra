import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { Note } from '../types/note';
import './NoteCard.css';

const SNIPPET_LEN = 220;

function snippet(body: string): string {
  const text = body.trim().replace(/\s+/g, ' ');
  return text.length > SNIPPET_LEN ? `${text.slice(0, SNIPPET_LEN)}…` : text;
}

interface Props {
  note: Note;
  // First unresolved conflict copy shadowing this note, if any, + how many there are.
  conflictId?: string;
  conflictCount?: number;
  onResolveConflict?: (conflictId: string) => void;
}

export default function NoteCard({ note, conflictId, conflictCount, onResolveConflict }: Props) {
  const title = note.title.trim() || 'Untitled';
  // YAML `color` drives the card surface; fall back to the design token.
  const style = note.color ? { background: note.color } : undefined;

  const className = `note-card${note.color ? ' note-card--colored' : ''}`;

  return (
    <Link to={`/note/${encodeURIComponent(note.id)}`} className="note-card__link">
      <article className={className} style={style}>
        {conflictId && (
          // The banner lives inside the card's Link, so swallow the click to open
          // the resolver instead of navigating into the note.
          <button
            type="button"
            className="note-card__conflict"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onResolveConflict?.(conflictId); }}
          >
            <AlertTriangle size={14} />
            {conflictCount && conflictCount > 1
              ? `${conflictCount} sync conflicts — resolve`
              : 'Sync conflict — resolve'}
          </button>
        )}
        <h3 className="note-card__title">{title}</h3>
        {note.body.trim() && (
          <p className="note-card__snippet">{snippet(note.body)}</p>
        )}
        {note.tags.length > 0 && (
          <ul className="note-card__tags">
            {note.tags.map(tag => (
              <li key={tag} className="note-card__tag">{tag}</li>
            ))}
          </ul>
        )}
      </article>
    </Link>
  );
}
