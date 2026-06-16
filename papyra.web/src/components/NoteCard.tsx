import { Link } from 'react-router-dom';
import type { Note } from '../types/note';
import './NoteCard.css';

const SNIPPET_LEN = 220;

function snippet(body: string): string {
  const text = body.trim().replace(/\s+/g, ' ');
  return text.length > SNIPPET_LEN ? `${text.slice(0, SNIPPET_LEN)}…` : text;
}

export default function NoteCard({ note }: { note: Note }) {
  const title = note.title.trim() || 'Untitled';
  // YAML `color` drives the card surface; fall back to the design token.
  const style = note.color ? { background: note.color } : undefined;

  const className = `note-card${note.color ? ' note-card--colored' : ''}`;

  return (
    <Link to={`/note/${encodeURIComponent(note.id)}`} className="note-card__link">
      <article className={className} style={style}>
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
