// Multi-select: the API calls and the pure rules behind them. The component
// layer (BulkBar, the grid) stays thin; everything here is unit-tested.

import { fetchWithProgress } from './progress';

export type BulkAction = 'pin' | 'unpin' | 'archive' | 'unarchive' | 'trash' | 'untrash' | 'delete';
export type BulkStatus = 'changed' | 'unchanged' | 'notFound' | 'notTrashed';
export type ShareStatus = 'shared' | 'upgraded' | 'alreadyShared' | 'locked' | 'notFound';

export interface BulkResult<S extends string> {
  results: { id: string; status: S }[];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetchWithProgress(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Pin/archive/trash (and back) for a whole selection in one request. */
export function bulkAction(ids: string[], action: BulkAction) {
  return postJson<BulkResult<BulkStatus> & { changed: number }>('/api/notes/bulk', { ids, action });
}

/** Share a selection with one person. */
export function bulkShare(noteIds: string[], granteeUsername: string, access: 'view' | 'edit') {
  return postJson<BulkResult<ShareStatus> & { shared: number; grantee: string }>(
    '/api/shares/bulk', { noteIds, granteeUsername, access });
}

/** ids with the given status, in the order the server reported them. */
export function idsWith<S extends string>(result: BulkResult<S>, ...statuses: S[]): string[] {
  return result.results.filter((r) => statuses.includes(r.status)).map((r) => r.id);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a finished share did, in one sentence — naming every kind of skip. */
export function shareSummary(result: BulkResult<ShareStatus> & { grantee: string }): string {
  const count = (s: ShareStatus) => result.results.filter((r) => r.status === s).length;
  const done = count('shared') + count('upgraded');
  const parts: string[] = [];
  parts.push(done > 0
    ? `Shared ${plural(done, 'note')} with ${result.grantee}.`
    : `Nothing new to share with ${result.grantee}.`);
  if (count('alreadyShared')) parts.push(`${plural(count('alreadyShared'), 'note was', 'notes were')} already shared.`);
  if (count('locked')) parts.push(`${plural(count('locked'), 'locked note')} skipped — unlock ${count('locked') === 1 ? 'it' : 'them'} to share.`);
  if (count('notFound')) parts.push(`${plural(count('notFound'), 'note')} couldn't be found.`);
  return parts.join(' ');
}

/**
 * Shift-click selection: everything between the anchor and the clicked card in
 * display order, inclusive, in either direction. No anchor (or one that has
 * since left the grid) selects just the clicked card.
 */
export function rangeBetween(ordered: string[], anchor: string | null, target: string): string[] {
  const to = ordered.indexOf(target);
  if (to < 0) return [];
  const from = anchor === null ? -1 : ordered.indexOf(anchor);
  if (from < 0) return [target];
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return ordered.slice(lo, hi + 1);
}

/** Next selection after a click: toggle one, or add a whole shift-range. */
export function nextSelection(
  current: ReadonlySet<string>, ordered: string[], anchor: string | null, target: string, shift: boolean,
): Set<string> {
  const next = new Set(current);
  if (shift && anchor !== null) {
    for (const id of rangeBetween(ordered, anchor, target)) next.add(id);
    return next;
  }
  if (next.has(target)) next.delete(target);
  else next.add(target);
  return next;
}

/**
 * Where a group of cards dragged together lands: each gets a sort key that
 * places the whole group, contiguous and in its current order, at `index` of
 * the target section (whose id list already excludes the group). `keyOf` is a
 * card's current sort key; `between` spreads `count` keys between neighbours.
 */
export function planGroupDrop(
  group: string[],
  targetIds: string[],
  index: number,
  keyOf: (id: string) => number,
  between: (above: number | null, below: number | null, count: number) => number[],
): Map<string, number> {
  const at = Math.max(0, Math.min(index, targetIds.length));
  const above = at > 0 ? keyOf(targetIds[at - 1]) : null;
  const below = at < targetIds.length ? keyOf(targetIds[at]) : null;
  const keys = between(above, below, group.length);
  return new Map(group.map((id, i) => [id, keys[i]]));
}
