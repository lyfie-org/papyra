import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pin, PinOff } from 'lucide-react';
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable,
  type DragStartEvent, type DragMoveEvent,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
import {
  useNoteOrder, useSaveOrder, sortNotes, effectiveKey, keyBetween,
  ORDER_KEY, type OrderMap,
} from '../hooks/useNoteOrder';
import NoteCard from './NoteCard';
import {
  pack, columnsFor, indexFromPoint, neighborsAt, EST_H,
  type Box, type Placed,
} from '../lib/noteGridLayout';
import '../components/NoteGrid.css';
import './DraggableNoteGrid.css';

interface Props {
  notes: Note[];
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
}

type Section = 'pinned' | 'others';

// One absolutely-positioned card. No DragOverlay: the dragged card itself rides
// the pointer via dnd-kit's transform delta (delta == pointer movement from the
// grab point), so it stays glued to the cursor. Others reflow via `box` + CSS
// transition. dnd-kit reads no card box for layout (no droppables) → no loop.
function AbsCard({
  note, box, colW, onMeasure, conflictsByParent, onResolveConflict,
}: {
  note: Note; box: Box | undefined; colW: number;
  onMeasure: (id: string, h: number) => void;
} & Pick<Props, 'conflictsByParent' | 'onResolveConflict'>) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: note.id });
  const elRef = useRef<HTMLDivElement | null>(null);
  const conflicts = conflictsByParent?.get(note.id);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setNodeRef(el);
    if (el) onMeasure(note.id, el.offsetHeight);
  }, [setNodeRef, onMeasure, note.id]);

  useLayoutEffect(() => {
    if (elRef.current) onMeasure(note.id, elRef.current.offsetHeight);
  });

  const x = (box?.x ?? 0) + (isDragging && transform ? transform.x : 0);
  const y = (box?.y ?? 0) + (isDragging && transform ? transform.y : 0);

  return (
    <div
      ref={setRef}
      className="dnd-card"
      style={{
        position: 'absolute', top: 0, left: 0, width: colW,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        transition: isDragging ? 'none' : 'transform 0.22s cubic-bezier(0.2, 0, 0, 1)',
        zIndex: isDragging ? 30 : 1,
      }}
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

export default function DraggableNoteGrid({ notes, conflictsByParent, onResolveConflict }: Props) {
  const queryClient = useQueryClient();
  const { data: order } = useNoteOrder();
  const saveOrder = useSaveOrder();

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<HTMLDivElement | null>(null);
  const othersRef = useRef<HTMLDivElement | null>(null);

  const [width, setWidth] = useState(0);
  const heights = useRef<Map<string, number>>(new Map());
  const [, forceTick] = useState(0);
  // While dragging, heights are fixed — re-measuring mid-drag would re-pack and
  // jitter. This ref gates that (a ref, so the measure callback sees it live).
  const dragging = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Section | null>(null);
  // The dragged card's resting box at grab time — its pointer-follow baseline.
  const [startBox, setStartBox] = useState<Box | null>(null);
  // Pointer position at grab (viewport coords); add the drag delta to track it.
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  // Where the dragged card would land: which section + index. Drives make-room.
  const [drop, setDrop] = useState<{ section: Section; index: number } | null>(null);

  const active = notes.filter(n => !n.archived && !n.trashed && n.kind !== 'todo');
  const pinned = useMemo(() => sortNotes(active.filter(n => n.pinned), order), [active, order]);
  const others = useMemo(() => sortNotes(active.filter(n => !n.pinned), order), [active, order]);
  const byId = useMemo(() => new Map(active.map(n => [n.id, n])), [active]);

  // Track wrap width (drives column count).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const onMeasure = useCallback((id: string, h: number) => {
    if (dragging.current) return; // heights are frozen mid-drag
    if (h > 0 && heights.current.get(id) !== h) {
      heights.current.set(id, h);
      forceTick(t => t + 1); // re-pack with the real height
    }
  }, []);

  const { cols, colW } = columnsFor(width);

  // Section id lists, minus the dragged card; the gap goes in the target section.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const pinnedIds = pinned.map(n => n.id).filter(id => id !== activeId);
  const othersIds = others.map(n => n.id).filter(id => id !== activeId);
  const activeH = activeId ? (heights.current.get(activeId) ?? EST_H) : 0;

  // BASE = resting layout of the non-dragged cards (no gap). Hit-testing uses this
  // so inserting the gap never shifts the centres we test against (no oscillation).
  const pinnedBase = pack(pinnedIds, heights.current, cols, colW);
  const othersBase = pack(othersIds, heights.current, cols, colW);
  // DISPLAY = base, plus the make-room gap at the drop index (what we render).
  const pinnedLayout = drop?.section === 'pinned'
    ? pack(pinnedIds, heights.current, cols, colW, { index: drop.index, h: activeH })
    : pinnedBase;
  const othersLayout = drop?.section === 'others'
    ? pack(othersIds, heights.current, cols, colW, { index: drop.index, h: activeH })
    : othersBase;

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    const o: Section = byId.get(id)?.pinned ? 'pinned' : 'others';
    // Resting box of the card in its full (idle) section layout — the baseline the
    // pointer delta is added to so the card tracks the cursor exactly.
    const idle = pack((o === 'pinned' ? pinned : others).map(n => n.id), heights.current, cols, colW);
    setStartBox(idle.boxes.get(id) ?? { x: 0, y: 0 });
    const ev = e.activatorEvent as PointerEvent;
    pointerStart.current = { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
    dragging.current = true;
    setActiveId(id);
    setOrigin(o);
    setDrop({ section: o, index: (o === 'pinned' ? pinned : others).findIndex(n => n.id === id) });
  }

  function onDragMove(e: DragMoveEvent) {
    const p = pointerStart.current;
    if (!p) return;
    // Track the actual pointer (grab point + delta), not the card centre — a tall
    // card's centre lags the cursor and would drop notes in the wrong slot.
    const cx = p.x + e.delta.x;
    const cy = p.y + e.delta.y;
    const pinRect = pinnedRef.current?.getBoundingClientRect();
    const othRect = othersRef.current?.getBoundingClientRect();
    // Pick the section whose vertical band the dragged centre sits in.
    let section: Section = 'others';
    if (pinRect && othRect) section = cy < othRect.top ? 'pinned' : 'others';
    else if (pinRect) section = 'pinned';
    const rect = section === 'pinned' ? pinRect : othRect;
    if (!rect) return;
    const px = cx - rect.left;
    const py = cy - rect.top;
    // Hit-test against the BASE (ungapped) centres so the gap never feeds back.
    const base = section === 'pinned' ? pinnedBase : othersBase;
    const index = indexFromPoint(base.centers, px, py);
    setDrop(prev => (prev && prev.section === section && prev.index === index) ? prev : { section, index });
  }

  function reset() {
    dragging.current = false; pointerStart.current = null;
    setActiveId(null); setOrigin(null); setDrop(null); setStartBox(null);
  }

  // Drop handler — dnd-kit passes the event, but the committed position comes from
  // our own hit-testing state (activeId/origin/drop), so the event isn't needed.
  async function onDragEnd() {
    const id = activeId;
    const o = origin;
    const d = drop;
    if (!id || !o || !d) { reset(); return; }

    const targetIds = d.section === 'pinned' ? pinnedIds : othersIds;
    const { aboveId, belowId } = neighborsAt(targetIds, d.index);
    const above = aboveId ? byId.get(aboveId) : undefined;
    const below = belowId ? byId.get(belowId) : undefined;
    const newKey = keyBetween(
      above ? effectiveKey(above, order) : null,
      below ? effectiveKey(below, order) : null,
    );

    // `setAt` stamps when the drag was committed, so a later edit can retire a stale
    // manual position. Reading the clock is impure, but this runs only from
    // DndContext's onDragEnd — never during render. The lint rule can't prove a
    // component-body function is event-only, so silence it here deliberately.
    // eslint-disable-next-line react-hooks/purity
    const droppedAt = Date.now();
    const nextOrder: OrderMap = { ...(order ?? {}), [id]: { key: newKey, setAt: droppedAt } };
    const crossed = d.section !== o;
    const note = byId.get(id);

    queryClient.setQueryData(ORDER_KEY, nextOrder);
    if (crossed && note) {
      queryClient.setQueryData<Note[]>(['notes'], prev =>
        prev?.map(n => n.id === id ? { ...n, pinned: d.section === 'pinned' } : n));
      await fetch(`/api/notes/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: note.title, tags: note.tags, color: note.color,
          pinned: d.section === 'pinned', archived: note.archived, kind: note.kind, body: note.body,
        }),
      });
    }

    reset();
    saveOrder.mutate(nextOrder);
    if (crossed) await queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  if (active.length === 0) return <p className="note-grid__empty">No notes yet.</p>;

  const crossing = drop !== null && origin !== null && drop.section !== origin;
  const boxFor = (n: Note, layout: Placed): Box | undefined =>
    n.id === activeId ? (startBox ?? undefined) : layout.boxes.get(n.id);

  const showPinnedHeading = pinned.length > 0;
  const showOthersHeading = pinned.length > 0 && others.length > 0;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <div className="note-grid-wrap" ref={wrapRef}>
        {showPinnedHeading && <h2 className="note-grid__heading">PINNED</h2>}
        <div className="dnd-canvas" ref={pinnedRef} style={{ height: pinnedLayout.height }}>
          {pinned.map(n => (
            <AbsCard key={n.id} note={n} colW={colW} box={boxFor(n, pinnedLayout)}
              onMeasure={onMeasure}
              conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
          ))}
        </div>

        {showOthersHeading && <h2 className="note-grid__heading">OTHERS</h2>}
        <div className="dnd-canvas" ref={othersRef} style={{ height: othersLayout.height }}>
          {others.map(n => (
            <AbsCard key={n.id} note={n} colW={colW} box={boxFor(n, othersLayout)}
              onMeasure={onMeasure}
              conflictsByParent={conflictsByParent} onResolveConflict={onResolveConflict} />
          ))}
        </div>
      </div>

      {crossing && (
        <div className="dnd-banner" role="status">
          {drop?.section === 'pinned' ? <Pin size={18} /> : <PinOff size={18} />}
          {drop?.section === 'pinned' ? 'Pin this note' : 'Unpin this note'}
        </div>
      )}
    </DndContext>
  );
}
