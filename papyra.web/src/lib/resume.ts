import type { QueryClient } from '@tanstack/react-query';
import { checkServerVersion } from './serverVersion';

/**
 * Fired when the app comes back to the foreground after being away (a phone PWA
 * brought out of the app switcher, a laptop woken from sleep, a tab restored from
 * the back/forward cache). The real-time hub listens: its socket usually died
 * while the page was frozen, and every event sent meanwhile is gone.
 */
export const RESUME_EVENT = 'papyra:resume';

/** Shorter than this is an app-switch glance, not an absence worth a catch-up. */
const AWAY_MS = 3_000;

/**
 * Freshness here is pushed by SignalR (so queries don't refetch on focus), but a
 * backgrounded phone app has no socket: it came back showing whatever it last
 * knew, until the person dragged down to reload the page. Catch up on return
 * instead — re-read what the server says, drop dead sockets, check for a new
 * release. Notes are left to the hub listener, which routes them through the
 * focus-mode buffer so a catch-up never lands in the middle of an edit.
 */
export function installResumeRefresh(queryClient: QueryClient): void {
  let hiddenAt: number | null = null;

  const resume = (awayMs: number) => {
    if (awayMs < AWAY_MS || !navigator.onLine) return;
    window.dispatchEvent(new Event(RESUME_EVENT));
    void checkServerVersion();
    void queryClient.invalidateQueries({ predicate: q => q.queryKey[0] !== 'notes' });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt === null) return;
    const away = Date.now() - hiddenAt;
    hiddenAt = null;
    resume(away);
  });

  // Restored from the back/forward cache: no visibilitychange tells how long.
  window.addEventListener('pageshow', e => {
    if (e.persisted) {
      hiddenAt = null;
      resume(Infinity);
    }
  });
}
