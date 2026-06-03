import { useQuery } from '@tanstack/react-query';
import { Users } from '@phosphor-icons/react';
import { getSharedNotes } from '../api/userApi';
import { useAuth } from '../hooks/useAuth';
import { useUserSettingsCtx } from '../context/UserSettingsContext';
import type { NoteSummary } from '../types';
import { resolveTheme } from '../lib/noteThemes';
import './SharedNotesSection.css';

const SHARED_KEY = ['notes', 'shared'] as const;

interface Props {
  onNoteClick: (id: string) => void;
}

export default function SharedNotesSection({ onNoteClick }: Props) {
  const { data: auth } = useAuth();
  const { settings, update } = useUserSettingsCtx();
  const { data: shared, isLoading } = useQuery({
    queryKey: SHARED_KEY,
    queryFn:  getSharedNotes,
    staleTime: 30_000,
  });

  if (isLoading || !shared || shared.length === 0) return null;

  const pinned     = settings?.pinnedSharedNotes ?? [];
  const isPinned   = (id: string) => pinned.includes(id);

  function togglePin(id: string) {
    const next = isPinned(id)
      ? pinned.filter(p => p !== id)
      : [...pinned, id];
    update({ pinnedSharedNotes: next });
  }

  // Sort: pinned first, then alphabetically by title
  const sorted = [...shared].sort((a: NoteSummary, b: NoteSummary) => {
    const aPin = isPinned(a.id) ? 0 : 1;
    const bPin = isPinned(b.id) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    return a.title.localeCompare(b.title);
  });

  return (
    <section className="shared-section">
      <header className="shared-section__header">
        <Users size={16} aria-hidden="true" className="shared-section__icon" />
        <h2 className="shared-section__title">Shared with me</h2>
      </header>

      <div className="shared-section__grid">
        {sorted.map((note: NoteSummary) => (
          <SharedNoteCard
            key={note.id}
            note={note}
            pinned={isPinned(note.id)}
            currentUser={auth?.username ?? ''}
            onClick={() => onNoteClick(note.id)}
            onTogglePin={() => togglePin(note.id)}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  note:        NoteSummary;
  pinned:      boolean;
  currentUser: string;
  onClick:     () => void;
  onTogglePin: () => void;
}

function SharedNoteCard({ note, pinned, onClick, onTogglePin }: CardProps) {
  const { colorTheme, artTheme } = resolveTheme(note.color ?? '');
  const ownerInitials = (note.owner ?? '?').slice(0, 2).toUpperCase();

  return (
    <article
      className={`shared-note-card${pinned ? ' shared-note-card--pinned' : ''}`}
      data-note-theme={colorTheme}
      data-note-art={artTheme}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-label={`Open shared note: ${note.title}`}
    >
      <div className="shared-note-card__body">
        <h3 className="shared-note-card__title">{note.title || 'Untitled'}</h3>

        {note.tags && note.tags.length > 0 && (
          <ul className="shared-note-card__tags" aria-label="Tags">
            {note.tags.map(tag => (
              <li key={tag} className="shared-note-card__tag">{tag}</li>
            ))}
          </ul>
        )}
      </div>

      <footer className="shared-note-card__footer">
        {/* Owner avatar badge */}
        <span
          className="shared-note-card__owner-badge"
          title={`Owned by ${note.owner ?? 'unknown'}`}
          aria-label={`Owner: ${note.owner}`}
        >
          {ownerInitials}
        </span>

        {/* Pin toggle */}
        <button
          className={`shared-note-card__pin${pinned ? ' shared-note-card__pin--active' : ''}`}
          onClick={e => { e.stopPropagation(); onTogglePin(); }}
          aria-label={pinned ? 'Unpin from workspace' : 'Pin to workspace'}
          title={pinned ? 'Unpin from workspace' : 'Pin to workspace'}
        >
          {pinned ? '📌' : '📍'}
        </button>
      </footer>
    </article>
  );
}
