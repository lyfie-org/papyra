import Masonry from 'react-masonry-css';
import { useNotes } from '../hooks/useNotes';
import NoteCard from './NoteCard';
import './NoteGrid.css';

const breakpointCols = {
  default: 4,
  1280: 3,
  900: 2,
  600: 1,
};

interface NoteGridProps {
  onNoteClick: (id: string) => void;
}

export default function NoteGrid({ onNoteClick }: NoteGridProps) {
  const { data: notes, isLoading, isError } = useNotes();

  if (isLoading) return <p className="note-grid__status">Loading notes…</p>;
  if (isError)   return <p className="note-grid__status">Failed to load notes.</p>;
  if (!notes?.length) return <p className="note-grid__status">No notes yet. Create one!</p>;

  return (
    <Masonry
      breakpointCols={breakpointCols}
      className="note-grid"
      columnClassName="note-grid__column"
    >
      {notes.map(note => (
        <NoteCard
          key={note.id}
          note={note}
          onClick={() => onNoteClick(note.id)}
        />
      ))}
    </Masonry>
  );
}
