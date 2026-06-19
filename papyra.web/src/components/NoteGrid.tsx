import Masonry from 'react-masonry-css';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
import NoteCard, { type CardVariant } from './NoteCard';
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
  // Which slice of the vault this grid shows; also drives each card's actions.
  variant?: CardVariant;
  emptyLabel?: string;
  // parentId → its unresolved conflict copies (drives the per-card banner).
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
}

interface SectionProps {
  notes: Note[];
  variant: CardVariant;
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
}

function MasonrySection({ notes, variant, conflictsByParent, onResolveConflict }: SectionProps) {
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
            variant={variant}
            conflictId={conflicts?.[0]?.id}
            conflictCount={conflicts?.length}
            onResolveConflict={onResolveConflict}
          />
        );
      })}
    </Masonry>
  );
}

export default function NoteGrid({
  notes, variant = 'active', emptyLabel = 'No notes yet.', conflictsByParent, onResolveConflict,
}: GridProps) {
  // Each slice is mutually exclusive: trashed wins, then archived, then active.
  const slice = notes.filter(n =>
    variant === 'trashed' ? n.trashed
    : variant === 'archived' ? n.archived && !n.trashed
    : !n.archived && !n.trashed);

  if (slice.length === 0) {
    return <p className="note-grid__empty">{emptyLabel}</p>;
  }

  // Only the active desk groups pinned notes; archive/trash are flat lists.
  const pinned = variant === 'active' ? slice.filter(n => n.pinned) : [];
  const standard = variant === 'active' ? slice.filter(n => !n.pinned) : slice;

  return (
    <div className="note-grid-wrap">
      {pinned.length > 0 && (
        <>
          <h2 className="note-grid__heading">PINNED</h2>
          <MasonrySection notes={pinned} variant={variant} conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
        </>
      )}
      {standard.length > 0 && (
        <>
          {pinned.length > 0 && <h2 className="note-grid__heading">OTHERS</h2>}
          <MasonrySection notes={standard} variant={variant} conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
        </>
      )}
    </div>
  );
}
