const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeInfo {
  /** Short line for the card: "Deletes forever on 31 Dec". */
  label: string;
  /** The full date and time, for the tooltip. */
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
  const left = at.getTime() - now.getTime();
  const title = `Erased for good after ${at.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}`;
  if (left <= 0) return { label: 'Deletes forever soon', title, soon: true };

  const days = Math.ceil(left / DAY_MS);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const date = at.toDateString() === now.toDateString()
    ? 'today'
    : at.toDateString() === tomorrow.toDateString()
      ? 'tomorrow'
      : `on ${at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear()
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return { label: `Deletes forever ${date}`, title, soon: days <= 3 };
}
