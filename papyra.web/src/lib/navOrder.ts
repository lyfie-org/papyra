import { useMemo } from 'react';
import { useLocal, writeLocal } from './localStore';

/** The three places a person writes, which can be put in any order in the sidebar. */
export const WRITING_PLACES = ['notes', 'todo', 'journal'] as const;
export type WritingPlace = (typeof WRITING_PLACES)[number];

const KEY = 'papyra-nav-order';

/** A stored order made whole: unknown names dropped, repeats dropped, anything missing added in the default order. */
export function normalizeOrder(raw: readonly string[] | null | undefined, available: readonly WritingPlace[] = WRITING_PLACES): WritingPlace[] {
  const out: WritingPlace[] = [];
  for (const id of raw ?? []) {
    if ((available as readonly string[]).includes(id) && !out.includes(id as WritingPlace)) out.push(id as WritingPlace);
  }
  for (const id of available) if (!out.includes(id)) out.push(id);
  return out;
}

function parse(raw: string | null): WritingPlace[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    return normalizeOrder(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
  } catch {
    return normalizeOrder(null);
  }
}

/** Notes, To Do and Journal in the order this person put them (default: that order). */
export function useNavOrder(): WritingPlace[] {
  const raw = useLocal(KEY);
  return useMemo(() => parse(raw), [raw]);
}

/** Put the three in this order; the default order is stored as nothing at all. */
export function setNavOrder(order: readonly WritingPlace[]): void {
  const whole = normalizeOrder(order);
  const isDefault = whole.every((id, i) => id === WRITING_PLACES[i]);
  writeLocal(KEY, isDefault ? null : JSON.stringify(whole));
}

/** `order` with `id` moved one place up (-1) or down (+1); unchanged at the ends. */
export function moved(order: readonly WritingPlace[], id: WritingPlace, by: -1 | 1): WritingPlace[] {
  const from = order.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
