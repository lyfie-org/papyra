import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, Pin, PinOff } from 'lucide-react';
import {
  DndContext, PointerSensor, useSensor, useSensors, useDraggable,
  type DragStartEvent, type DragMoveEvent,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';
import type { Conflict } from '../hooks/useConflicts';
import {
  useNoteOrder, useSaveOrder, sortNotes, effectiveKey, keysBetween,
  ORDER_KEY, type OrderMap,
} from '../hooks/useNoteOrder';
import NoteCard from './NoteCard';
import TodoCard from './TodoCard';
import BulkBar from './BulkBar';
import {
  pack, columnsFor, indexFromPoint, EST_H,
  type Box, type Placed,
} from '../lib/noteGridLayout';
import { bulkAction, planGroupDrop, plural } from '../lib/bulk';
import { useFlipPosition } from '../hooks/useFlipPosition';
import { useGridWidth } from '../hooks/useGridWidth';
import { useSelection } from '../hooks/useSelection';
import { useToast } from '../lib/toastContext';
import '../components/NoteGrid.css';
import './DraggableNoteGrid.css';

interface Props {
  notes: Note[];
  conflictsByParent?: Map<string, Conflict[]>;
  onResolveConflict?: (conflictId: string) => void;
  /** Show to-do lists too — a smart collection can be made of them. */
  includeTodos?: boolean;
  /** Only to-do lists, drawn as checklists (the To Do page). */
  todosOnly?: boolean;
}

type Section = 'pinned' | 'others';

// Where a card follows the dragged one while a selection is carried as a group:
// stacked just behind it, slightly fanned.
const STACK_STEP = 6;

// One absolutely-positioned card. No DragOverlay: the dragged card itself rides
// the pointer via dnd-kit's transform delta (delta == pointer movement from the
// grab point), so it stays glued to the cursor. Others glide to their slots
// (useFlipPosition). dnd-kit reads no card box for layout (no droppables) → no loop.
//
// Memoised on primitive props (position as x/y numbers, this card's own
// conflicts, its own selected flag) so a change to one note — or ticking one
// card — re-renders one card, not hundreds.
const AbsCard = memo(function AbsCard({
  note, x: boxX, y: boxY, colW, cols, resizedAt, onMeasure, conflicts, onResolveConflict,
  todo, selected, selecting, onToggle, following, stackIndex, carrying,
}: {
  note: Note; x: number; y: number; colW: number; cols: number; resizedAt: RefObject<number>;
  onMeasure: (id: string, h: number) => void;
  conflicts: Conflict[] | undefined;
  onResolveConflict?: (conflictId: string) => void;
  todo: boolean;
  selected: boolean;
  /** The grid is in selection mode: a click anywhere on a card toggles it. */
  selecting: boolean;
  onToggle: (id: string, shift: boolean) => void;
  /** Riding behind the dragged card as part of a group. */
  following: boolean;
  stackIndex: number;
  /** How many cards the dragged card carries (itself included); 0 when alone. */
  carrying: number;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: note.id });
  const elRef = useRef<HTMLDivElement | null>(null);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setNodeRef(el);
    if (el) onMeasure(note.id, el.offsetHeight);
  }, [setNodeRef, onMeasure, note.id]);

  useLayoutEffect(() => {
    if (elRef.current) onMeasure(note.id, elRef.current.offsetHeight);
  });

  const x = boxX + (isDragging && transform ? transform.x : 0);
  const y = boxY + (isDragging && transform ? transform.y : 0);
  // Glide to a new slot from wherever the card visibly is; snap while the
  // window is merely widening a column (see useFlipPosition).
  useFlipPosition(elRef, x, y, { cols, colW, frozen: isDragging, resizedAt });

  const title = note.title.trim() || 'Untitled';
  const cls = ['dnd-card', selected && 'is-selected', following && 'is-following', isDragging && 'is-dragging']
    .filter(Boolean).join(' ');

  return (
    <div
      ref={setRef}
      className={cls}
      style={{
        position: 'absolute', top: 0, left: 0, width: colW,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        zIndex: isDragging ? 30 : following ? 29 - stackIndex : 1,
      }}
      // In selection mode the whole card is the checkbox: a click selects
      // instead of opening, ticking a to-do item, or pressing a card button.
      onClickCapture={selecting ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(note.id, e.shiftKey);
      } : undefined}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className="select-tick"
        aria-pressed={selected}
        aria-label={`${selected ? 'Deselect' : 'Select'} “${title}”`}
        title={selecting ? undefined : 'Select'}
        // Never the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(note.id, e.shiftKey); }}
      >
        <Check size={14} strokeWidth={3} aria-hidden="true" />
      </button>
      {carrying > 1 && <span className="dnd-card__carry" aria-hidden="true">{carrying}</span>}
      {todo ? (
        <TodoCard note={note} />
      ) : (
        <NoteCard
          note={note}
          variant="active"
          conflictId={conflicts?.[0]?.id}
          conflictCount={conflicts?.length}
          onResolveConflict={onResolveConflict}
        />
      )}
    </div>
  );
});

export default function DraggableNoteGrid({
  notes, conflictsByParent, onResolveConflict, includeTodos = false, todosOnly = false,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: order } = useNoteOrder();
  const saveOrder = useSaveOrder();

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<HTMLDivElement | null>(null);
  const othersRef = useRef<HTMLDivElement | null>(null);

  const heights = useRef<Map<string, number>>(new Map());
  const [, forceTick] = useState(0);
  // While dragging, heights are fixed — re-measuring mid-drag would re-pack and
  // jitter. This ref gates that (a ref, so the measure callback sees it live).
  const dragging = useRef(false);
  // True between a drag ending and the synthetic click it produces.
  const suppressClick = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Section | null>(null);
  // The dragged card's resting box at grab time — its pointer-follow baseline.
  const [startBox, setStartBox] = useState<Box | null>(null);
  // Pointer position at grab (viewport coords); add the drag delta to track it.
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  // Where the dragged card would land: which section + index. Drives make-room.
  const [drop, setDrop] = useState<{ section: Section; index: number } | null>(null);
  // Cards carried together (the dragged one first, then the rest of the
  // selection in display order). Just the dragged card for a plain drag.
  const [group, setGroup] = useState<string[]>([]);
  // Live drag offset + the vertical distance from each canvas to the other, so
  // followers in the other section can stack under the dragged card.
  const [drag, setDrag] = useState<{ dx: number; dy: number; pinToOthers: number } | null>(null);

  // 'todo' lives on the To Do page and 'inbox' on /inbox — neither belongs on
  // the notes desk, which is for notes the user wrote here.
  const active = notes.filter(n => !n.archived && !n.trashed && n.kind !== 'inbox'
    && (todosOnly ? n.kind === 'todo' : includeTodos || n.kind !== 'todo'));
  const pinned = useMemo(() => sortNotes(active.filter(n => n.pinned), order), [active, order]);
  const others = useMemo(() => sortNotes(active.filter(n => !n.pinned), order), [active, order]);
  const byId = useMemo(() => new Map(active.map(n => [n.id, n])), [active]);
  const ordered = useMemo(() => [...pinned, ...others].map(n => n.id), [pinned, others]);
  const { width, resizedAt, sticky, recordColumns } = useGridWidth(wrapRef, active.length > 0);
  const selection = useSelection(ordered);

  const onMeasure = useCallback((id: string, h: number) => {
    if (dragging.current) return; // heights are frozen mid-drag
    if (h > 0 && heights.current.get(id) !== h) {
      heights.current.set(id, h);
      forceTick(t => t + 1); // re-pack with the real height
    }
  }, []);

  const { cols, colW } = columnsFor(width);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Section id lists, minus everything being carried; the gap goes in the target section.
  const carried = useMemo(() => new Set(group), [group]);
  const pinnedIds = pinned.map(n => n.id).filter(id => !carried.has(id));
  const othersIds = others.map(n => n.id).filter(id => !carried.has(id));
  const activeH = activeId ? (heights.current.get(activeId) ?? EST_H) : 0;

  // BASE = resting layout of the non-dragged cards (no gap). Hit-testing uses this
  // so inserting the gap never shifts the centres we test against (no oscillation).
  // Mid-resize, cards hold their columns (see useGridWidth).
  const prefer = sticky.current ?? undefined;
  const pinnedBase = pack(pinnedIds, heights.current, cols, colW, undefined, prefer);
  const othersBase = pack(othersIds, heights.current, cols, colW, undefined, prefer);
  // DISPLAY = base, plus the make-room gap at the drop index (what we render).
  const pinnedLayout = drop?.section === 'pinned'
    ? pack(pinnedIds, heights.current, cols, colW, { index: drop.index, h: activeH }, prefer)
    : pinnedBase;
  const othersLayout = drop?.section === 'others'
    ? pack(othersIds, heights.current, cols, colW, { index: drop.index, h: activeH }, prefer)
    : othersBase;

  // Hand the current column assignment back, for the next resize to hold.
  useLayoutEffect(() => {
    recordColumns(new Map([...pinnedBase.columns, ...othersBase.columns]));
  });

  // Stable across renders (changes only with the card list), so ticking one
  // card doesn't re-render every memoised card.
  const onToggle = selection.toggle;

  function canvasGap(): number {
    const pin = pinnedRef.current?.getBoundingClientRect();
    const oth = othersRef.current?.getBoundingClientRect();
    return pin && oth ? oth.top - pin.top : 0;
  }

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    const o: Section = byId.get(id)?.pinned ? 'pinned' : 'others';
    // Resting box of the card in its full (idle) section layout — the baseline the
    // pointer delta is added to so the card tracks the cursor exactly.
    const idle = pack((o === 'pinned' ? pinned : others).map(n => n.id), heights.current, cols, colW, undefined, prefer);
    setStartBox(idle.boxes.get(id) ?? { x: 0, y: 0 });
    const ev = e.activatorEvent as PointerEvent;
    pointerStart.current = { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
    dragging.current = true;
    // Dragging a selected card carries the whole selection with it.
    const carry = selection.selected.has(id) && selection.selected.size > 1
      ? [id, ...ordered.filter(x => x !== id && selection.selected.has(x))]
      : [id];
    setGroup(carry);
    setActiveId(id);
    setOrigin(o);
    setDrag({ dx: 0, dy: 0, pinToOthers: canvasGap() });
    const rest = (o === 'pinned' ? pinned : others).map(n => n.id).filter(x => !carry.includes(x));
    // Start where the first carried card sat among what's left.
    const firstIdx = (o === 'pinned' ? pinned : others).findIndex(n => n.id === id);
    const index = (o === 'pinned' ? pinned : others).slice(0, firstIdx).filter(n => !carry.includes(n.id)).length;
    setDrop({ section: o, index: Math.min(index, rest.length) });
  }

  function onDragMove(e: DragMoveEvent) {
    const p = pointerStart.current;
    if (!p) return;
    if (group.length > 1) setDrag({ dx: e.delta.x, dy: e.delta.y, pinToOthers: canvasGap() });
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
    setActiveId(null); setOrigin(null); setDrop(null); setStartBox(null); setGroup([]); setDrag(null);
  }

  // Armed the moment a drag ends so the trailing click can be swallowed. Two
  // layers: the grid's onClickCapture, and a native listener on window capture.
  // The native one is what actually holds: dnd-kit stops that click's
  // propagation at document level, so React never sees it — and a stopped but
  // not prevented click on a card's <a> is a full page navigation into the note,
  // which also threw away the drop's order save. Window capture runs before
  // dnd-kit's listener and prevents the default. Cleared on a timer as well as
  // on consumption: if the browser never emits that click, a stale guard must
  // not eat the user's next real one.
  function armClickSuppression() {
    suppressClick.current = true;
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      suppressClick.current = false;
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => {
      suppressClick.current = false;
      window.removeEventListener('click', swallow, { capture: true });
    }, 300);
  }

  // Drop handler — dnd-kit passes the event, but the committed position comes from
  // our own hit-testing state (group/drop), so the event isn't needed.
  async function onDragEnd() {
    // Arm first: a drag that ends outside a valid drop target still produced the
    // pointerup whose click would otherwise open the note.
    armClickSuppression();
    const d = drop;
    // The group lands in display order, whichever card was grabbed.
    const moving = ordered.filter(id => carried.has(id));
    if (!activeId || !d || moving.length === 0) { reset(); return; }

    const targetIds = d.section === 'pinned' ? pinnedIds : othersIds;
    const keys = planGroupDrop(moving, targetIds, d.index,
      id => { const n = byId.get(id); return n ? effectiveKey(n, order) : 0; }, keysBetween);

    // `setAt` stamps when the drag was committed (bookkeeping; a placed note keeps
    // its position until dragged again — see effectiveKey). Reading the clock is impure, but this runs only from
    // DndContext's onDragEnd — never during render. The lint rule can't prove a
    // component-body function is event-only, so silence it here deliberately.
    // eslint-disable-next-line react-hooks/purity
    const droppedAt = Date.now();
    const nextOrder: OrderMap = { ...(order ?? {}) };
    for (const [id, key] of keys) nextOrder[id] = { key, setAt: droppedAt };

    // Carried across the PINNED/OTHERS line: every card that isn't already on
    // that side gets pinned (or unpinned) with it — flag only, never the body.
    const toPinned = d.section === 'pinned';
    const flip = moving.filter(id => byId.get(id)?.pinned !== toPinned);

    queryClient.setQueryData(ORDER_KEY, nextOrder);
    if (flip.length) {
      const set = new Set(flip);
      queryClient.setQueryData<Note[]>(['notes'], prev =>
        prev?.map(n => set.has(n.id) ? { ...n, pinned: toPinned } : n));
    }
    reset();
    saveOrder.mutate(nextOrder);
    if (flip.length) {
      try {
        await bulkAction(flip, toPinned ? 'pin' : 'unpin');
      } catch (e) {
        toast(`Couldn't ${toPinned ? 'pin' : 'unpin'} ${plural(flip.length, 'note')}: ${(e as Error).message}`);
      }
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
  }

  if (active.length === 0) return <p className="note-grid__empty">No notes yet.</p>;

  const crossing = drop !== null && origin !== null && drop.section !== origin;
  const carrying = group.length;

  // Followers stack behind the dragged card, fanned a few pixels each; one in
  // the other section converts through the distance between the two canvases.
  const followBox = (n: Note, index: number): Box | undefined => {
    if (!startBox || !drag || !origin) return undefined;
    const section: Section = n.pinned ? 'pinned' : 'others';
    const shift = section === origin ? 0 : section === 'others' ? -drag.pinToOthers : drag.pinToOthers;
    return {
      x: startBox.x + drag.dx + STACK_STEP * index,
      y: startBox.y + drag.dy + STACK_STEP * index + shift,
    };
  };

  const renderCard = (n: Note, layout: Placed) => {
    const stackIndex = group.indexOf(n.id);
    const following = stackIndex > 0;
    const box = n.id === activeId
      ? startBox ?? undefined
      : following ? followBox(n, stackIndex) : layout.boxes.get(n.id);
    return (
      <AbsCard key={n.id} note={n} colW={colW} cols={cols} resizedAt={resizedAt}
        x={box?.x ?? 0} y={box?.y ?? 0}
        onMeasure={onMeasure}
        conflicts={conflictsByParent?.get(n.id)} onResolveConflict={onResolveConflict}
        todo={todosOnly}
        selected={selection.selected.has(n.id)}
        selecting={selection.active}
        onToggle={onToggle}
        following={following}
        stackIndex={Math.max(0, stackIndex)}
        carrying={n.id === activeId ? carrying : 0}
      />
    );
  };

  const showPinnedHeading = pinned.length > 0;
  const showOthersHeading = pinned.length > 0 && others.length > 0;
  const noun = todosOnly ? 'list' : 'note';

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => { armClickSuppression(); reset(); }}
    >
      {/* Each card's content is a <Link>, so the pointerup that ends a drag also
          fires a click and navigated into the note the user was merely
          rearranging. Swallow exactly that click: the sensor needs 8px of travel
          before a drag starts, so reaching here guarantees a real drag happened
          and never a plain click-to-open. */}
      <div
        className={`note-grid-wrap${selection.active ? ' is-selecting' : ''}`}
        ref={wrapRef}
        onClickCapture={(e) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {showPinnedHeading && <h2 className="note-grid__heading">PINNED</h2>}
        <div className="dnd-canvas" ref={pinnedRef} style={{ height: pinnedLayout.height }}>
          {pinned.map(n => renderCard(n, pinnedLayout))}
        </div>

        {showOthersHeading && <h2 className="note-grid__heading">OTHERS</h2>}
        <div className="dnd-canvas" ref={othersRef} style={{ height: othersLayout.height }}>
          {others.map(n => renderCard(n, othersLayout))}
        </div>
      </div>

      {crossing && (
        <div className="dnd-banner" role="status">
          {drop?.section === 'pinned' ? <Pin size={18} /> : <PinOff size={18} />}
          {drop?.section === 'pinned'
            ? `Pin ${carrying > 1 ? plural(carrying, noun) : `this ${noun}`}`
            : `Unpin ${carrying > 1 ? plural(carrying, noun) : `this ${noun}`}`}
        </div>
      )}

      {selection.active && (
        <BulkBar
          notes={ordered.filter(id => selection.selected.has(id)).map(id => byId.get(id)!)}
          total={ordered.length}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
        />
      )}
    </DndContext>
  );
}
