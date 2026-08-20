// The single seam every note write goes through. Online it is a plain PUT;
// offline (or when the API is simply unreachable) the write lands in the
// IndexedDB outbox instead of throwing, and the sync engine replays it when the
// connection returns. Reads merge the outbox back over the server snapshot so
// the UI always shows the user's own latest text, online or not.

import type { Note } from '../types/note';
import {
  pendingWrites, queueWrite, removeWrite, type NoteWritePayload, type OutboxEntry,
} from './outbox';
import { refreshPending, setSync, getSyncState } from './syncStatus';

export type SaveOutcome = 'saved' | 'queued';

/**
 * Statuses where replaying the same write again could never work, so the entry
 * is dropped instead of blocking the queue forever. Everything else — 401/403
 * (session expired while offline), 429, 5xx — keeps the write queued.
 */
const DISCARDABLE = new Set([400, 404, 410, 413, 422]);

/** How long a save waits on the network before falling back to the outbox. */
const SAVE_TIMEOUT_MS = 8_000;

/** A failed fetch (TypeError) or a gateway-class status means "can't reach the API". */
function isOffline(res?: Response): boolean {
  if (!navigator.onLine) return true;
  if (!res) return true;
  return res.status === 502 || res.status === 503 || res.status === 504;
}

/**
 * Persist a note. Returns 'saved' when the API took it, 'queued' when it was
 * parked in the outbox. Throws only for real API rejections (401/403/413/…),
 * which are the caller's problem, not the network's.
 */
export async function putNote(
  id: string,
  payload: NoteWritePayload,
  base?: string,
): Promise<SaveOutcome> {
  const park = async (): Promise<SaveOutcome> => {
    await queueWrite({ id, payload, base, queuedAt: new Date().toISOString() });
    await refreshPending();
    setSync({ online: false });
    return 'queued';
  };

  // Don't make the user watch "Saving…" spin against a server we already know is
  // down — a refused connection can take seconds to fail. The hub tells us the
  // moment the API dies, so park straight away and let the engine replay.
  if (!navigator.onLine || !getSyncState().online) return park();

  let res: Response;
  try {
    res = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // A hung server must not hold a save open forever; the outbox is right there.
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch {
    return park(); // network layer refused — treat as offline, never lose the edit
  }

  if (!res.ok) {
    // Unreachable API, expired session, rate limit, server error: park it. The
    // edit is the user's, and none of those are reasons to throw it away.
    if (isOffline(res) || !DISCARDABLE.has(res.status)) {
      if (res.status === 401 || res.status === 403) setSync({ authRequired: true });
      return park();
    }
    throw new Error(`PUT /api/notes/${id} failed: ${res.status}`);
  }

  // A successful write means we're back: drop any stale queued copy of this note
  // so the replay can't later overwrite what we just sent.
  await removeWrite(id);
  await refreshPending();
  if (!getSyncState().online) setSync({ online: true });
  return 'saved';
}

/** Server snapshot with queued local edits laid over the top. */
export async function fetchNotesMerged(): Promise<Note[]> {
  let notes: Note[];
  try {
    const res = await fetch('/api/notes');
    if (!res.ok) throw new Error(`GET /api/notes failed: ${res.status}`);
    notes = await res.json();
    // The service worker tags a cached replay, so a 200 that never touched the
    // network doesn't get mistaken for a healthy connection.
    setSync({ online: res.headers.get('X-Papyra-Cache') !== 'hit' });
  } catch (err) {
    // Offline: the service worker replays the last good /api/notes response, so
    // this only really fails on a cold first-ever load with no cache.
    setSync({ online: false });
    throw err;
  }

  const queued = await pendingWrites();
  return mergeQueued(notes, queued);
}

/**
 * Lay queued (unsynced) writes over the server snapshot. A note the user edited
 * offline shows their text, and a note they created offline appears at all —
 * both stamped with the queue time so recency sorting puts them where the user
 * expects. Pure, so it's unit-testable without IndexedDB.
 */
export function mergeQueued(notes: Note[], queued: OutboxEntry[]): Note[] {
  if (queued.length === 0) return notes;
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const entry of queued) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, {
      ...(existing ?? {
        id: entry.id, trashed: false, secure: false, updated: entry.queuedAt,
      } as Note),
      ...entry.payload,
      id: entry.id,
      updated: entry.queuedAt,
    });
  }
  return [...byId.values()];
}

/**
 * Replay the outbox oldest-first. Last-write-wins: a queued edit overwrites a
 * newer server revision, but the API snapshots the previous body before every
 * write, so the overwritten text stays recoverable — and we surface which notes
 * that happened to.
 */
export async function flushOutbox(): Promise<{ synced: number; conflicts: string[] }> {
  const queued = await pendingWrites();
  if (queued.length === 0) {
    await refreshPending();
    return { synced: 0, conflicts: [] };
  }

  setSync({ syncing: true });
  // One snapshot of the server state is enough to spot revisions that moved on
  // while we were away.
  let serverById = new Map<string, Note>();
  try {
    const res = await fetch('/api/notes');
    if (res.ok) serverById = new Map(((await res.json()) as Note[]).map((n) => [n.id, n]));
  } catch {
    setSync({ syncing: false, online: false });
    return { synced: 0, conflicts: [] };
  }

  const conflicts: string[] = [];
  let synced = 0;

  for (const entry of queued) {
    const server = serverById.get(entry.id);
    const movedOn = !!(server && entry.base && server.updated > entry.base);
    let res: Response;
    try {
      res = await fetch(`/api/notes/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.payload),
      });
    } catch {
      setSync({ syncing: false, online: false });
      await refreshPending();
      return { synced, conflicts }; // still offline — keep the rest queued
    }
    if (!res.ok) {
      if (isOffline(res)) {
        setSync({ syncing: false, online: false });
        await refreshPending();
        return { synced, conflicts };
      }
      // Anything that could succeed later KEEPS the entry — losing a user's
      // offline writing is the one unforgivable failure here. A restarted server
      // (session expired → 401) or a transient 5xx must not eat the queue.
      if (!DISCARDABLE.has(res.status)) {
        setSync({ syncing: false, authRequired: res.status === 401 || res.status === 403 });
        await refreshPending();
        return { synced, conflicts };
      }
      // Genuinely unwritable (note gone, payload rejected): drop it rather than
      // wedging every later write behind one that can never succeed.
      await removeWrite(entry.id);
      continue;
    }
    await removeWrite(entry.id);
    synced += 1;
    if (movedOn) conflicts.push(entry.payload.title || entry.id);
  }

  const pending = await refreshPending();
  setSync({
    syncing: false,
    online: true,
    authRequired: false,
    lastSyncedAt: pending === 0 ? new Date().toISOString() : getSyncState().lastSyncedAt,
    conflicts: conflicts.length ? conflicts : getSyncState().conflicts,
  });
  return { synced, conflicts };
}

export type { NoteWritePayload, OutboxEntry };
