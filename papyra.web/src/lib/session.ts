import type { QueryClient } from '@tanstack/react-query';
import { clearWrites } from './outbox';

/**
 * Wipe everything the signed-in user left behind in this browser.
 *
 * Papyra is self-hosted and often shared — a family machine, a kiosk, a work
 * laptop — so "sign out" has to mean the next person sees nothing of the last
 * one. The server is correctly partitioned per user, but three client-side
 * stores outlive a sign-out and each leaks across accounts on their own:
 *
 *   - the React Query cache, which holds notes, categories, inbox and shares;
 *   - the service worker's cached API responses, readable offline;
 *   - the IndexedDB outbox, whose entries are keyed by note id with no owner,
 *     so a pending write would replay into whoever signs in next.
 *
 * Call this on every path that ends a session, including an expired one.
 */
export async function clearSessionData(queryClient: QueryClient): Promise<void> {
  // Synchronous and first: it's what the UI reads, so clearing it before the
  // route change means no frame can paint the previous user's notes.
  queryClient.clear();

  navigator.serviceWorker?.controller?.postMessage({ type: 'papyra-clear-data' });

  await clearWrites();
}
