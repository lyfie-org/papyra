import Masonry from 'react-masonry-css';
import type { Note } from '../types/note';
import NoteCard from './NoteCard';
import './NoteGrid.css';

// Responsive column counts keyed by max viewport width (px). ~250px min col.
const BREAKPOINTS = {
  default: 5,
  1400: 4,
  1100: 3,
  700: 2,
  500: 1,
};

function MasonrySection({ notes }: { notes: Note[] }) {
  return (
    <Masonry
      breakpointCols={BREAKPOINTS}
      className="note-grid"
      columnClassName="note-grid__col"
    >
      {notes.map(note => (
        <NoteCard key={note.id} note={note} />
      ))}
    </Masonry>
  );
}

export default function NoteGrid({ notes }: { notes: Note[] }) {
  // Archived notes live on disk (archived: true in frontmatter) but stay out of
  // the main desk — the toolbar's Archive action sets the flag.
  const active = notes.filter(n => !n.archived);
  const pinned = active.filter(n => n.pinned);
  const standard = active.filter(n => !n.pinned);

  if (active.length === 0) {
    return <p className="note-grid__empty">No notes yet.</p>;
  }

  return (
    <div className="note-grid-wrap">
      {pinned.length > 0 && (
        <>
          <h2 className="note-grid__heading">PINNED</h2>
          <MasonrySection notes={pinned} />
        </>
      )}
      {standard.length > 0 && (
        <>
          {pinned.length > 0 && <h2 className="note-grid__heading">OTHERS</h2>}
          <MasonrySection notes={standard} />
        </>
      )}
    </div>
  );
}
