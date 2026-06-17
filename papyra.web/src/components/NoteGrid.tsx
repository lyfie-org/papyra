import Masonry from 'react-masonry-css';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
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

interface GridProps {
  notes: Note[];
  // parentId → its unresolved conflict copies (drives the per-card banner).
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
}

function MasonrySection({ notes, conflictsByParent, onResolveConflict }: GridProps) {
  return (
    <Masonry
      breakpointCols={BREAKPOINTS}
      className="note-grid"
      columnClassName="note-grid__col"
    >
      {notes.map(note => {
        const conflicts = conflictsByParent?.get(note.id);
        return (
          <NoteCard
            key={note.id}
            note={note}
            conflictId={conflicts?.[0]?.id}
            conflictCount={conflicts?.length}
            onResolveConflict={onResolveConflict}
          />
        );
      })}
    </Masonry>
  );
}

export default function NoteGrid({ notes, conflictsByParent, onResolveConflict }: GridProps) {
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
          <MasonrySection notes={pinned} conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
        </>
      )}
      {standard.length > 0 && (
        <>
          {pinned.length > 0 && <h2 className="note-grid__heading">OTHERS</h2>}
          <MasonrySection notes={standard} conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
        </>
      )}
    </div>
  );
}
