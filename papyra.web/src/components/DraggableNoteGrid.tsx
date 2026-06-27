import { useMemo, useState } from 'react';
import Masonry from 'react-masonry-css';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors,
  useDroppable, closestCenter, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, sortableKeyboardCoordinates, rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
import {
  useNoteOrder, useSaveOrder, sortNotes, effectiveKey, keyBetween,
  type OrderMap,
} from '../hooks/useNoteOrder';
import NoteCard from './NoteCard';
import '../components/NoteGrid.css';
import './DraggableNoteGrid.css';

interface Props {
  notes: Note[];
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
}

type Section = 'pinned' | 'others';
const DROPPABLE: Record<Section, string> = { pinned: '__pinned__', others: '__others__' };

// ~250px min column, mirrors the old masonry breakpoints.
const BREAKPOINTS = { default: 5, 1400: 4, 1100: 3, 700: 2, 500: 1 };

// Keep the card from morphing during reorder: don't animate layout shifts (the
// DragOverlay shows the lifted card instead), and hide the in-place original
// while it's being dragged so only the overlay is visible.
function SortableCard({
  note, conflictsByParent, onResolveConflict,
}: { note: Note } & Pick<Props, 'conflictsByParent' | 'onResolveConflict'>) {
  // Deliberately ignore the sortable transform/transition: dnd-kit's strategies
  // compute sibling shifts for a uniform grid, which warp a masonry layout. We
  // keep siblings static and let the DragOverlay show the lift; masonry re-flows
  // once on drop. Only the in-place original is hidden while dragging.
  const { attributes, listeners, setNodeRef, isDragging } =
    useSortable({ id: note.id, animateLayoutChanges: () => false });
  const conflicts = conflictsByParent?.get(note.id);
  return (
    <div
      ref={setNodeRef}
      className="dnd-card"
      style={{ opacity: isDragging ? 0 : 1 }}
      {...attributes}
      {...listeners}
    >
      <NoteCard
        note={note}
        variant="active"
        conflictId={conflicts?.[0]?.id}
        conflictCount={conflicts?.length}
        onResolveConflict={onResolveConflict}
      />
    </div>
  );
}

// Wraps a section's masonry so a card can be dropped into it even when empty.
function DroppableSection({ section, children }: { section: Section; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: DROPPABLE[section] });
  return <div ref={setNodeRef} className="dnd-section">{children}</div>;
}

export default function DraggableNoteGrid({ notes, conflictsByParent, onResolveConflict }: Props) {
  const queryClient = useQueryClient();
  const { data: order } = useNoteOrder();
  const saveOrder = useSaveOrder();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Todos live in the To Do tab, not the notes desk.
  const active = notes.filter(n => !n.archived && !n.trashed && n.kind !== 'todo');
  const pinned = useMemo(() => sortNotes(active.filter(n => n.pinned), order), [active, order]);
  const others = useMemo(() => sortNotes(active.filter(n => !n.pinned), order), [active, order]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = useMemo(() => new Map(active.map(n => [n.id, n])), [active]);
  const sectionOf = (id: string): Section => byId.get(id)?.pinned ? 'pinned' : 'others';

  function onDragStart(e: DragStartEvent) { setActiveId(String(e.active.id)); }

  async function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active: dragged, over } = event;
    if (!over) return;
    const activeId = String(dragged.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const target: Section =
      overId === DROPPABLE.pinned ? 'pinned'
      : overId === DROPPABLE.others ? 'others'
      : sectionOf(overId);

    const list = (target === 'pinned' ? pinned : others).filter(n => n.id !== activeId);
    const insertIdx = overId === DROPPABLE.pinned || overId === DROPPABLE.others
      ? list.length
      : Math.max(0, list.findIndex(n => n.id === overId));

    const aboveNote = list[insertIdx - 1];
    const belowNote = list[insertIdx];
    const newKey = keyBetween(
      aboveNote ? effectiveKey(aboveNote, order) : null,
      belowNote ? effectiveKey(belowNote, order) : null,
    );

    const nextOrder: OrderMap = { ...(order ?? {}), [activeId]: { key: newKey, setAt: Date.now() } };

    const crossed = sectionOf(activeId) !== target;
    if (crossed) {
      const note = byId.get(activeId);
      if (note) {
        queryClient.setQueryData<Note[]>(['notes'], prev =>
          prev?.map(n => n.id === activeId ? { ...n, pinned: target === 'pinned' } : n));
        await fetch(`/api/notes/${encodeURIComponent(activeId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: note.title, tags: note.tags, color: note.color,
            pinned: target === 'pinned', archived: note.archived, kind: note.kind, body: note.body,
          }),
        });
      }
    }

    saveOrder.mutate(nextOrder);
    if (crossed) await queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  if (active.length === 0) {
    return <p className="note-grid__empty">No notes yet.</p>;
  }

  const activeNote = activeId ? byId.get(activeId) : null;

  const renderSection = (section: Section, items: Note[]) => (
    <SortableContext id={DROPPABLE[section]} items={items.map(n => n.id)} strategy={rectSortingStrategy}>
      <DroppableSection section={section}>
        <Masonry breakpointCols={BREAKPOINTS} className="note-grid" columnClassName="note-grid__col">
          {items.map(n => (
            <SortableCard key={n.id} note={n}
              conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
          ))}
        </Masonry>
      </DroppableSection>
    </SortableContext>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="note-grid-wrap">
        {pinned.length > 0 && <h2 className="note-grid__heading">PINNED</h2>}
        {renderSection('pinned', pinned)}
        {pinned.length > 0 && others.length > 0 && <h2 className="note-grid__heading">OTHERS</h2>}
        {renderSection('others', others)}
      </div>

      <DragOverlay>
        {activeNote
          ? <div className="dnd-card dnd-card--overlay"><NoteCard note={activeNote} variant="active" /></div>
          : null}
      </DragOverlay>
    </DndContext>
  );
}
