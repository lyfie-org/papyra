// ── Offline mutation queue context ────────────────────────────────────────
//
// Stores note updates in IndexedDB when the server is unreachable.
// Replays them in FIFO order when connectivity returns.
// Conflict policy: last-write-wins (the replayed mutation lands on top of
// any server-side changes that happened while offline).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { enqueueDb, dequeueDb, listQueueDb, type QueuedMutation } from '../lib/queue-db';
import { notesApi } from '../api/notes';
import { NOTES_KEY, noteKey } from '../hooks/useNotes';
import type { UpdateNoteRequest } from '../types';

interface OfflineQueueContextValue {
  pendingCount: number;
  isSyncing: boolean;
  queueUpdate: (noteId: string, req: UpdateNoteRequest) => Promise<void>;
}

const OfflineQueueContext = createContext<OfflineQueueContextValue>({
  pendingCount: 0,
  isSyncing:    false,
  queueUpdate:  async () => {},
});

export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const qc           = useQueryClient();
  const [count,  setCount]    = useState(0);
  const [syncing, setSyncing] = useState(false);
  const replayLock = useRef(false);

  // Seed count from IndexedDB on mount
  useEffect(() => {
    listQueueDb().then(items => setCount(items.length)).catch(() => {});
  }, []);

  const replay = useCallback(async () => {
    if (replayLock.current || !navigator.onLine) return;
    replayLock.current = true;
    setSyncing(true);
    try {
      const items = await listQueueDb();
      if (!items.length) return;

      // Oldest first
      items.sort((a, b) => a.timestamp - b.timestamp);

      for (const item of items) {
        if (!navigator.onLine) break;
        try {
          await notesApi.update(
            item.noteId,
            item.req as UpdateNoteRequest,
            item.idempotencyKey,
          );
          await dequeueDb(item.id);
          setCount(c => Math.max(0, c - 1));
        } catch {
          // Leave in queue — will retry on next online event
          break;
        }
      }
      // Refresh the query cache after replaying
      await qc.invalidateQueries({ queryKey: NOTES_KEY });
    } finally {
      replayLock.current = false;
      setSyncing(false);
    }
  }, [qc]);

  // Replay on browser reconnect
  useEffect(() => {
    window.addEventListener('online', replay);
    // Also try immediately on mount in case we're already online with items queued
    replay();
    return () => window.removeEventListener('online', replay);
  }, [replay]);

  const queueUpdate = useCallback(
    async (noteId: string, req: UpdateNoteRequest) => {
      const mutation: QueuedMutation = {
        id:             `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        noteId,
        req:            req as Record<string, unknown>,
        idempotencyKey: `${noteId}-${Date.now()}`,
        timestamp:      Date.now(),
      };
      await enqueueDb(mutation);
      setCount(c => c + 1);
      // Optimistically invalidate the note detail so the saved content stays
      qc.invalidateQueries({ queryKey: noteKey(noteId) });
    },
    [qc],
  );

  return (
    <OfflineQueueContext.Provider value={{ pendingCount: count, isSyncing: syncing, queueUpdate }}>
      {children}
    </OfflineQueueContext.Provider>
  );
}

export function useOfflineQueue() {
  return useContext(OfflineQueueContext);
}
