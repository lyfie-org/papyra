import { Pin } from 'lucide-react';
import type { NoteSummary } from '../types';
import './NoteCard.css';

interface NoteCardProps {
  note: NoteSummary & { content?: string };
  onClick: () => void;
}

const MAX_CONTENT_CHARS = 180;

export default function NoteCard({ note, onClick }: NoteCardProps) {
  const snippet = note.content
    ? note.content.length > MAX_CONTENT_CHARS
      ? note.content.slice(0, MAX_CONTENT_CHARS).trimEnd() + '…'
      : note.content
    : null;

  return (
    <article
      className="note-card"
      style={{ backgroundColor: note.color || '#ffffff' }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-label={`Open note: ${note.title}`}
    >
      <header className="note-card__header">
        <h2 className="note-card__title">{note.title}</h2>
        {note.pinned && (
          <Pin className="note-card__pin" size={16} aria-label="Pinned" />
        )}
      </header>

      {snippet && <p className="note-card__content">{snippet}</p>}

      {note.tags.length > 0 && (
        <ul className="note-card__tags" aria-label="Tags">
          {note.tags.map(tag => (
            <li key={tag} className="note-card__tag">
              {tag}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
