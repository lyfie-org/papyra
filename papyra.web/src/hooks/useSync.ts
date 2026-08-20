import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { flushOutbox } from '../lib/notesApi';
import { getSyncState, refreshPending, setSync, subscribeSync, type SyncState } from '../lib/syncStatus';

// Read-only view of connectivity + outbox depth. Any component can subscribe.
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}

const RETRY_MS = 15_000;

/**
 * The sync engine. Mounted once (workspace shell): watches connectivity, drains
 * the outbox whenever the app is online with queued work, and refreshes the
 * notes cache after a successful drain so the grid shows what actually landed.
 */
export function useSyncEngine(): SyncState {
  const state = useSyncState();
  const queryClient = useQueryClient();

  const drain = useCallback(async () => {
    if (!navigator.onLine || getSyncState().syncing) return;
    if (getSyncState().pending === 0) return;
    const { synced } = await flushOutbox();
    if (synced > 0) await queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [queryClient]);

  useEffect(() => {
    void refreshPending();

    const goOnline = () => { setSync({ online: true }); void drain(); };
    const goOffline = () => setSync({ online: false });
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // `online` only fires on a real interface change — the API can die while the
    // browser still believes it has a network, so retry on a slow timer too.
    const timer = window.setInterval(() => { void drain(); }, RETRY_MS);
    void drain();

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.clearInterval(timer);
    };
  }, [drain]);

  return state;
}
