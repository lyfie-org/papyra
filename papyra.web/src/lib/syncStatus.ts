// Tiny external store for connectivity + outbox state, shared by the sidebar
// telemetry, the editor's save indicator and the sync engine. Kept outside React
// so non-component code (the save path in notesApi) can report into it without
// prop-drilling a context through every caller.

import { countWrites } from './outbox';

export interface SyncState {
  /** Browser connectivity. The API being unreachable also flips this false. */
  online: boolean;
  /** Note writes waiting in the outbox. */
  pending: number;
  /** A replay is in flight. */
  syncing: boolean;
  /** ISO time the outbox last drained completely. */
  lastSyncedAt: string | null;
  /**
   * Notes whose server revision had moved on when a queued edit replayed —
   * the local edit won (the API snapshots the previous revision first, so the
   * overwritten text is recoverable from File Recovery).
   */
  conflicts: string[];
  /**
   * The API rejected the replay with 401/403 — the session lapsed while the
   * edits were queued. The writes stay in the outbox; the user just has to sign
   * in again for them to land.
   */
  authRequired: boolean;
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  syncing: false,
  lastSyncedAt: null,
  conflicts: [],
  authRequired: false,
};

const listeners = new Set<() => void>();

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSyncState(): SyncState {
  return state;
}

export function setSync(patch: Partial<SyncState>): void {
  const next = { ...state, ...patch };
  // Reference equality drives useSyncExternalStore — only publish real changes.
  if (
    next.online === state.online &&
    next.pending === state.pending &&
    next.syncing === state.syncing &&
    next.lastSyncedAt === state.lastSyncedAt &&
    next.conflicts === state.conflicts &&
    next.authRequired === state.authRequired
  ) return;
  state = next;
  listeners.forEach((l) => l());
}

/** Re-read the outbox depth from IndexedDB and publish it. */
export async function refreshPending(): Promise<number> {
  const pending = await countWrites();
  setSync({ pending });
  return pending;
}
