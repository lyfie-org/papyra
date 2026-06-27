import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';

// One manual drag position: a fractional sort `key` plus the note's mtime (epoch
// ms) at drag time. The key is honoured only while the note hasn't been edited
// since — see effectiveKey — so an edit always wins over a stale drag.
export interface OrderEntry {
  key: number;
  setAt: number;
}
export type OrderMap = Record<string, OrderEntry>;

export const ORDER_KEY = ['noteOrder'] as const;
// Gap used when dropping at the very top/bottom of a section (epoch-ms scale).
export const ORDER_STEP = 60_000;

async function fetchOrder(): Promise<OrderMap> {
  const res = await fetch('/api/notes/order');
  if (!res.ok) throw new Error(`GET /api/notes/order failed: ${res.status}`);
  return res.json();
}

export function useNoteOrder() {
  return useQuery({ queryKey: ORDER_KEY, queryFn: fetchOrder });
}

export function useSaveOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (map: OrderMap) => {
      const entries = Object.entries(map).map(([id, e]) => ({ id, key: e.key, setAt: e.setAt }));
      const res = await fetch('/api/notes/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error(`PUT /api/notes/order failed: ${res.status}`);
      return res.json() as Promise<OrderMap>;
    },
    onSuccess: (data) => queryClient.setQueryData(ORDER_KEY, data),
  });
}

// The sort value for a note: its manual drag key while still valid, else its
// last-modified epoch. Editing a note (updated > setAt) discards the stale key,
// so the note jumps back to the top by recency.
export function effectiveKey(note: Note, order: OrderMap | undefined): number {
  const updatedMs = Date.parse(note.updated) || 0;
  const e = order?.[note.id];
  if (e && updatedMs <= e.setAt) return e.key;
  return updatedMs;
}

// Recency-or-manual order, highest key first.
export function sortNotes(notes: Note[], order: OrderMap | undefined): Note[] {
  return [...notes].sort((a, b) => effectiveKey(b, order) - effectiveKey(a, order));
}

// Fractional key for a note dropped between two neighbours (by their effective
// keys). Nulls mean the slot is the top/bottom edge of the section.
export function keyBetween(aboveKey: number | null, belowKey: number | null): number {
  if (aboveKey == null && belowKey == null) return Date.now();
  if (aboveKey == null) return (belowKey as number) + ORDER_STEP; // dropped at top
  if (belowKey == null) return aboveKey - ORDER_STEP;             // dropped at bottom
  return (aboveKey + belowKey) / 2;
}
