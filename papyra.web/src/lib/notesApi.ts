// The single seam every note write goes through. Online it is a plain PUT;
// offline (or when the API is simply unreachable) the write lands in the
// IndexedDB outbox instead of throwing, and the sync engine replays it when the
// connection returns. Reads merge the outbox back over the server snapshot so
// the UI always shows the user's own latest text, online or not.

import type { Note } from '../types/note';
import {
  pendingWrite, pendingWrites, queueWrite, removeWrite, type NoteWritePayload, type OutboxEntry,
} from './outbox';
import { refreshPending, setSync, getSyncState } from './syncStatus';
import { fetchWithProgress } from './progress';

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
 * A live (collaborative) editor's write carries `X-Papyra-Collab`: the API then
 * keeps the body that is on disk — the room's, flushed by the collab engine —
 * and takes only the metadata. Without it a stale body would be refused
 * (409 `collab_active`) and park in the outbox forever.
 */
export const COLLAB_HEADER = 'X-Papyra-Collab';

/**
 * `X-Papyra-Snapshot: force` — this write replaces a revision its editor never
 * adopted (the "modified externally" banner, an offline edit replayed over a
 * newer one). The API archives that revision first, past its snapshot throttle.
 */
export const SNAPSHOT_HEADER = 'X-Papyra-Snapshot';

function writeHeaders(collab: boolean, forceSnapshot = false): Record<string, string> {
  const headers: Record<string, string> = collab
    ? { 'Content-Type': 'application/json', [COLLAB_HEADER]: 'frontmatter' }
    : { 'Content-Type': 'application/json' };
  if (forceSnapshot) headers[SNAPSHOT_HEADER] = 'force';
  return headers;
}

/**
 * A body write that lost to a live room (409 `collab_active`) can never win by
 * repeating: the room owns the body and already holds everyone's edits (a live
 * editor's are also in its own IndexedDB). Send it again as metadata-only so
 * the title, tags and colour still land, and let the body go.
 */
async function retryMetadataOnly(
  id: string, payload: NoteWritePayload, res: Response, signal?: AbortSignal,
): Promise<Response | null> {
  if (res.status !== 409) return null;
  const code = ((await res.clone().json().catch(() => null)) as { code?: string } | null)?.code;
  if (code !== 'collab_active') return null;
  return fetch(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(true),
    body: JSON.stringify(payload),
    signal,
  });
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
  /**
   * `collab`: sent from a live editor — metadata only, the room owns the body.
   * `forceSnapshot`: replacing a revision the editor never adopted (see SNAPSHOT_HEADER).
   */
  opts?: { collab?: boolean; forceSnapshot?: boolean },
): Promise<SaveOutcome> {
  const collab = !!opts?.collab;
  const forceSnapshot = !!opts?.forceSnapshot;
  const park = async (): Promise<SaveOutcome> => {
    // A later write to the same note replaces the queued one, but must not drop
    // its promise to archive the revision it was going to overwrite.
    const sticky = forceSnapshot || !!(await pendingWrite(id).catch(() => undefined))?.forceSnapshot;
    await queueWrite({
      id, payload, base, queuedAt: new Date().toISOString(),
      ...(collab ? { collab } : {}), ...(sticky ? { forceSnapshot: true } : {}),
    });
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
      headers: writeHeaders(collab, forceSnapshot),
      body: JSON.stringify(payload),
      // A hung server must not hold a save open forever; the outbox is right there.
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch {
    return park(); // network layer refused — treat as offline, never lose the edit
  }

  if (res.status === 409) {
    try {
      res = (await retryMetadataOnly(id, payload, res, AbortSignal.timeout(SAVE_TIMEOUT_MS))) ?? res;
    } catch {
      return park();
    }
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
    const res = await fetchWithProgress('/api/notes');
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
    // A live editor's queued write is metadata only; its body is a placeholder
    // the server will ignore, so it must not paint over the room's text either.
    if (entry.collab && existing) {
      const { body: _ignored, ...meta } = entry.payload;
      void _ignored;
      byId.set(entry.id, { ...existing, ...meta, id: entry.id, updated: entry.queuedAt });
      continue;
    }
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
 * newer server revision, but that revision is archived first — the write asks
 * for it (SNAPSHOT_HEADER) past the API's snapshot throttle, which would
 * otherwise fold it away — so the overwritten text stays recoverable, and we
 * surface which notes that happened to.
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
        headers: writeHeaders(!!entry.collab, !!entry.forceSnapshot || movedOn),
        body: JSON.stringify(entry.payload),
      });
    } catch {
      setSync({ syncing: false, online: false });
      await refreshPending();
      return { synced, conflicts }; // still offline — keep the rest queued
    }
    if (res.status === 409 && !entry.collab) {
      // The note went live while this edit sat in the queue: its metadata
      // still applies, its body is the room's now (and worth telling the user).
      try {
        const retried = await retryMetadataOnly(entry.id, entry.payload, res);
        if (retried) {
          res = retried;
          if (res.ok && !movedOn) conflicts.push(entry.payload.title || entry.id);
        }
      } catch {
        setSync({ syncing: false, online: false });
        await refreshPending();
        return { synced, conflicts };
      }
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
