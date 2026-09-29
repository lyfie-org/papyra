/**
 * Which IndexedDB database holds each live room's offline copy
 * (`papyra-collab:{room}:{epoch}`, written by y-indexeddb in useCollabRoom).
 *
 * One database per room lineage: when a room is rebuilt from its file (a new
 * epoch) the old copy can never merge again, so it is deleted rather than left
 * to accumulate. Sign-out deletes them all — a shared note's text must not
 * outlive the session that could read it (see lib/session).
 *
 * Beside the database name each entry keeps what a later *offline* open needs
 * without a ticket: which note/share it belongs to, the lineage, and who was
 * editing (for presence and caret colour). Nothing here grants access — the
 * first reconnect asks the API for a real ticket before anything merges.
 */
const INDEX_KEY = 'papyra-collab-dbs';

/** A room's offline copy, as recorded after its first sync. */
export interface CachedCollabRoom {
  db: string;
  /** The hook's target key (`{"noteId":…}` / `{"shareId":…}`). */
  target: string;
  epoch: string;
  uid: number;
  username: string;
  name: string;
  /** The WebSocket path from the ticket. */
  url: string;
}

// Older entries are the bare database name: still deletable, never reopened.
type Entry = string | CachedCollabRoom;

function dbOf(entry: Entry): string {
  return typeof entry === 'string' ? entry : entry.db;
}

function readIndex(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, Entry>) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* storage off: nothing to track */ }
}

function drop(dbName: string) {
  try { indexedDB.deleteDatabase(dbName); } catch { /* IndexedDB unavailable */ }
}

/** Record the room's offline copy, deleting a previous lineage's. */
export function rememberCollabRoomCache(room: string, entry: CachedCollabRoom) {
  const index = readIndex();
  const previous = index[room];
  if (previous !== undefined && dbOf(previous) !== entry.db) drop(dbOf(previous));
  index[room] = entry;
  writeIndex(index);
}

/** The offline copy recorded for a target, if any (see useCollabRoom). */
export function findCollabRoomCache(target: string): { room: string; cache: CachedCollabRoom } | null {
  for (const [room, entry] of Object.entries(readIndex())) {
    if (typeof entry !== 'string' && entry.target === target) return { room, cache: entry };
  }
  return null;
}

/** Access to the room ended (revoked, note gone): delete its offline copy. */
export function forgetCollabRoomCache(room: string) {
  const index = readIndex();
  const entry = index[room];
  if (entry === undefined) return;
  drop(dbOf(entry));
  delete index[room];
  writeIndex(index);
}

/** Sign-out: delete every room's offline copy. */
export function clearCollabRoomCaches() {
  const index = readIndex();
  for (const entry of Object.values(index)) drop(dbOf(entry));
  try { localStorage.removeItem(INDEX_KEY); } catch { /* storage off */ }
}
