const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeInfo {
  /** Short line for the card: "Deletes forever in 13 days". */
  label: string;
  /** The date itself, for the tooltip: "Deletes forever on Thu, Oct 29, 2026, after 3:00 PM". */
  title: string;
  /** Three days or less to go — the card says it louder. */
  soon: boolean;
}

/**
 * When a trashed note will be erased, from when it was trashed and the retention
 * setting (days; -1 keeps forever). Null when there's nothing to promise: kept
 * forever, the setting isn't loaded yet, or the note has no trashed-at stamp
 * (the sweep never purges those either).
 *
 * The server sweeps every few hours, so the date is the earliest it can go —
 * which is the honest thing to put in front of someone deciding to restore.
 */
export function purgeInfo(
  trashedAt: string | null | undefined,
  retentionDays: number | undefined,
  now: Date = new Date(),
): PurgeInfo | null {
  if (retentionDays === undefined || retentionDays < 0 || !trashedAt) return null;
  const trashed = new Date(trashedAt);
  if (Number.isNaN(trashed.getTime())) return null;
  const at = new Date(trashed.getTime() + retentionDays * DAY_MS);
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const title = `Deletes forever on ${day}, after ${time}`;
  if (at.getTime() <= now.getTime()) return { label: 'Deletes forever soon', title, soon: true };

  // Whole calendar days, so "in 2 days" means the day after tomorrow however late it is.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return { label: `Deletes forever ${when}`, title, soon: days <= 3 };
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
