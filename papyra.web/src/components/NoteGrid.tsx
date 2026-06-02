import { useNotes } from '../hooks/useNotes';
import { useLayout } from '../context/LayoutContext';
import type { NoteSummary } from '../types';
import NoteCard from './NoteCard';
import './NoteGrid.css';

interface NoteGridProps {
  onNoteClick: (id: string) => void;
}

export default function NoteGrid({ onNoteClick }: NoteGridProps) {
  const { viewMode } = useLayout();
  const { data: notes, isLoading, isError } = useNotes();

  if (isLoading) return <p className="note-grid__status">Loading notes…</p>;
  if (isError)   return <p className="note-grid__status">Failed to load notes.</p>;
  if (!notes?.length) return <p className="note-grid__status">No notes yet. Create one!</p>;

  const pinnedNotes = notes.filter(n => n.pinned);
  const otherNotes  = notes.filter(n => !n.pinned);

  const renderSection = (items: NoteSummary[], isList: boolean) => (
    <div className={isList ? 'note-grid note-grid--list' : 'note-grid'}>
      {items.map(note => (
        <NoteCard key={note.id} note={note} onClick={() => onNoteClick(note.id)} />
      ))}
    </div>
  );

  const isList = viewMode === 'list';

  return (
    <div className="note-grid-canvas">
      {pinnedNotes.length > 0 && (
        <section className="note-section">
          <h3 className="note-section__label">PINNED</h3>
          {renderSection(pinnedNotes, isList)}
        </section>
      )}
      {otherNotes.length > 0 && (
        <section className="note-section">
          {renderSection(otherNotes, isList)}
        </section>
      )}
    </div>
  );
}
