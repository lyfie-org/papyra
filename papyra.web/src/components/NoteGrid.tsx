import { memo, useMemo, type ReactNode } from 'react';
import Masonry from 'react-masonry-css';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
import { useSelection } from '../hooks/useSelection';
import NoteCard, { type CardVariant } from './NoteCard';
import SelectTick from './SelectTick';
import BulkBar from './BulkBar';
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
  // A full explanation to show instead of emptyLabel. An empty section is where
  // the user most needs telling what the section is for, so prefer this.
  empty?: ReactNode;
  // parentId → its unresolved conflict copies (drives the per-card banner).
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
  /** Cards carry a tick; selecting brings up the bulk bar for this slice. */
  selectable?: boolean;
}

interface Selection {
  selected: ReadonlySet<string>;
  active: boolean;
  toggle: (id: string, shift?: boolean) => void;
}

// One card, optionally wrapped for selection. Memoised on the card's own
// selected flag, so ticking one card redraws one card.
const Cell = memo(function Cell({ note, variant, conflicts, onResolveConflict, selectable, selected, selecting, toggle }: {
  note: Note;
  variant: CardVariant;
  conflicts: Conflict[] | undefined;
  onResolveConflict?: (conflictId: string) => void;
  selectable: boolean;
  selected: boolean;
  selecting: boolean;
  toggle: (id: string, shift?: boolean) => void;
}) {
  const card = (
    <NoteCard
      note={note}
      variant={variant}
      conflictId={conflicts?.[0]?.id}
      conflictCount={conflicts?.length}
      onResolveConflict={onResolveConflict}
    />
  );
  if (!selectable) return card;
  return (
    <div
      className={`select-cell selectable${selected ? ' is-selected' : ''}`}
      // In selection mode the whole card is the checkbox: a click selects
      // instead of opening, restoring or deleting.
      onClickCapture={selecting ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(note.id, e.shiftKey);
      } : undefined}
    >
      <SelectTick
        title={note.title.trim() || 'Untitled'}
        selected={selected}
        selecting={selecting}
        onToggle={(shift) => toggle(note.id, shift)}
      />
      {card}
    </div>
  );
});

function MasonrySection({ notes, variant, conflictsByParent, onResolveConflict, selectable, selection }: {
  notes: Note[];
  variant: CardVariant;
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
  selectable: boolean;
  selection: Selection;
}) {
  return (
    <Masonry
      breakpointCols={BREAKPOINTS}
      className="note-grid"
      columnClassName="note-grid__col"
    >
      {notes.map(note => (
        <Cell
          key={note.id}
          note={note}
          variant={variant}
          conflicts={conflictsByParent?.get(note.id)}
          onResolveConflict={onResolveConflict}
          selectable={selectable}
          selected={selection.selected.has(note.id)}
          selecting={selection.active}
          toggle={selection.toggle}
        />
      ))}
    </Masonry>
  );
}

export default function NoteGrid({
  notes, variant = 'active', emptyLabel = 'No notes yet.', empty, conflictsByParent, onResolveConflict,
  selectable = false,
}: GridProps) {
  // Each slice is mutually exclusive: trashed wins, then archived, then active.
  const slice = useMemo(() => notes.filter(n =>
    variant === 'trashed' ? n.trashed
    : variant === 'archived' ? n.archived && !n.trashed
    : !n.archived && !n.trashed), [notes, variant]);

  // Only the active desk groups pinned notes; archive/trash are flat lists.
  const [pinned, standard] = useMemo(() => variant === 'active'
    ? [slice.filter(n => n.pinned), slice.filter(n => !n.pinned)]
    : [[], slice], [slice, variant]);
  const ordered = useMemo(() => [...pinned, ...standard].map(n => n.id), [pinned, standard]);
  const selection = useSelection(ordered);
  const byId = useMemo(() => new Map(slice.map(n => [n.id, n])), [slice]);

  if (slice.length === 0) {
    return empty ? <>{empty}</> : <p className="note-grid__empty">{emptyLabel}</p>;
  }

  const section = (list: Note[]) => (
    <MasonrySection notes={list} variant={variant} conflictsByParent={conflictsByParent}
      onResolveConflict={onResolveConflict} selectable={selectable} selection={selection} />
  );

  return (
    <div className={`note-grid-wrap${selection.active ? ' is-selecting' : ''}`}>
      {pinned.length > 0 && (
        <>
          <h2 className="note-grid__heading">PINNED</h2>
          {section(pinned)}
        </>
      )}
      {standard.length > 0 && (
        <>
          {pinned.length > 0 && <h2 className="note-grid__heading">OTHERS</h2>}
          {section(standard)}
        </>
      )}
      {selectable && selection.active && (
        <BulkBar
          mode={variant}
          notes={ordered.filter(id => selection.selected.has(id)).map(id => byId.get(id)!)}
          total={ordered.length}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
        />
      )}
    </div>
  );
}
