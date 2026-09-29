/**
 * Which IndexedDB database holds each live room's offline copy
 * (`papyra-collab:{room}:{epoch}`, written by y-indexeddb in useCollabRoom).
 *
 * One database per room lineage: when a room is rebuilt from its file (a new
 * epoch) the old copy can never merge again, so it is deleted rather than left
 * to accumulate. Sign-out deletes them all — a shared note's text must not
 * outlive the session that could read it (see lib/session).
 */
const INDEX_KEY = 'papyra-collab-dbs';

function readIndex(): Record<string, string> {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, string>) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* storage off: nothing to track */ }
}

function drop(dbName: string) {
  try { indexedDB.deleteDatabase(dbName); } catch { /* IndexedDB unavailable */ }
}

/** Record `dbName` as the room's offline copy, deleting a previous lineage's. */
export function rememberCollabRoomCache(room: string, dbName: string) {
  const index = readIndex();
  const previous = index[room];
  if (previous === dbName) return;
  if (previous) drop(previous);
  index[room] = dbName;
  writeIndex(index);
}

/** Access to the room ended (revoked, note gone): delete its offline copy. */
export function forgetCollabRoomCache(room: string) {
  const index = readIndex();
  const name = index[room];
  if (!name) return;
  drop(name);
  delete index[room];
  writeIndex(index);
}

/** Sign-out: delete every room's offline copy. */
export function clearCollabRoomCaches() {
  const index = readIndex();
  for (const name of Object.values(index)) drop(name);
  try { localStorage.removeItem(INDEX_KEY); } catch { /* storage off */ }
}
