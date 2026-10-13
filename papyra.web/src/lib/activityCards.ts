// The ActivityDock's cards over time: when a named task gets one (only once it
// has run a while), and how long a finished one lingers. Pure, so it is tested
// without a clock.
import type { LabelledTask } from './progress';

/** A named task that ends quicker than this never gets a card — its button said enough. */
export const DOCK_SHOW_AFTER_MS = 600;
/** Once shown, a card stays at least this long, so it can be read. */
const DOCK_MIN_VISIBLE_MS = 900;

export interface Card extends LabelledTask {
  /** When it appeared on screen. */
  shownAt: number;
  /** When it ended (the card then shows "done" briefly), or null while it runs. */
  endedAt: number | null;
}

/** How long a finished card lingers, ticked. */
const DONE_LINGER_MS = 500;

/** Next cards from the previous ones and the open named tasks, at `now`. Same array when nothing changed. */
export function stepCards(prev: Card[], open: LabelledTask[], now: number): Card[] {
  const live = new Map(open.map((t) => [t.id, t]));
  const next: Card[] = [];
  for (const card of prev) {
    const task = live.get(card.id);
    live.delete(card.id);
    if (task) {
      next.push({ ...card, ...task, endedAt: null });
      continue;
    }
    const endedAt = card.endedAt ?? now;
    if (now < Math.max(card.shownAt + DOCK_MIN_VISIBLE_MS, endedAt + DONE_LINGER_MS)) next.push({ ...card, endedAt });
  }
  for (const task of live.values()) {
    if (now - task.startedAt >= DOCK_SHOW_AFTER_MS) next.push({ ...task, shownAt: now, endedAt: null });
  }
  const same = next.length === prev.length && next.every((c, i) => c.id === prev[i]!.id
    && c.label === prev[i]!.label && c.progress === prev[i]!.progress && c.endedAt === prev[i]!.endedAt);
  return same ? prev : next;
}
