import type { DiffRow } from './lineDiff';

// Pure helpers behind the note History mode (NoteHistory.tsx): how a version's
// time reads, how much it differs from now, and how a long diff folds its
// unchanged stretches so the change itself is what you see.

export interface VersionMeta {
  id: string;
  timestamp: string;
}

/** Oldest → newest, the order the timeline reads left to right. */
export function chronological(list: VersionMeta[]): VersionMeta[] {
  return list.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago", "yesterday", "just now". */
export function relativeTime(then: Date, now: Date = new Date(), locale?: string): string {
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'minute') {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

/** "Sep 25, 3:31 PM" — the year only when it is not this year. */
export function formatStamp(then: Date, now: Date = new Date(), locale?: string): string {
  return then.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Lines only in this version (removed since) and only in the current note (added since). */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }
  return { added, removed };
}

export type FoldedRow =
  | (DiffRow & { type: 'row' })
  | { type: 'fold'; rows: DiffRow[] };

/**
 * Keep `context` unchanged lines around every change and fold the rest into
 * expandable runs. A fold shorter than 2 lines is not worth a control, so it is
 * shown as-is. With no change at all, everything folds into one run.
 */
export function foldUnchanged(rows: DiffRow[], context = 3): FoldedRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });

  const out: FoldedRow[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: 'fold', rows: run });
    else for (const r of run) out.push({ ...r, type: 'row' });
    run = [];
  };
  rows.forEach((r, i) => {
    if (keep[i]) {
      flush();
      out.push({ ...r, type: 'row' });
    } else {
      run.push(r);
    }
  });
  flush();
  return out;
}
