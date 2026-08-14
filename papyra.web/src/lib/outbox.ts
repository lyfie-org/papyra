// Durable queue of note writes that could not reach the API — the spine of
// offline editing. Entries survive a reload (and a browser restart) in
// IndexedDB, so a note edited on a train is still on disk-bound when the
// connection returns.
//
// Keyed by note id: a note only ever needs its LATEST body, so re-queuing the
// same id replaces the previous entry instead of stacking N revisions to
// replay. `base` records the server revision the edit started from, which lets
// the replay notice that someone else changed the note meanwhile.

export interface NoteWritePayload {
  title: string;
  tags: string[];
  color: string | null;
  pinned: boolean;
  archived: boolean;
  kind: 'note' | 'todo' | 'inbox';
  body: string;
}

export interface OutboxEntry {
  id: string;
  payload: NoteWritePayload;
  /** `updated` of the server revision this edit was based on (ISO), if known. */
  base?: string;
  /** When the edit was queued (ISO) — surfaced in the UI. */
  queuedAt: string;
}

const DB_NAME = 'papyra-outbox';
const DB_VERSION = 1;
const STORE = 'writes';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Queue (or replace) the pending write for a note. */
export async function queueWrite(entry: OutboxEntry): Promise<void> {
  await tx('readwrite', (s) => s.put(entry) as IDBRequest<IDBValidKey>);
}

/** Every queued write, oldest first. */
export async function pendingWrites(): Promise<OutboxEntry[]> {
  const all = await tx<OutboxEntry[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** The queued write for one note, if any. */
export async function pendingWrite(id: string): Promise<OutboxEntry | undefined> {
  return tx<OutboxEntry | undefined>('readonly', (s) => s.get(id) as IDBRequest<OutboxEntry | undefined>);
}

export async function removeWrite(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function countWrites(): Promise<number> {
  try {
    return await tx<number>('readonly', (s) => s.count() as IDBRequest<number>);
  } catch {
    return 0; // IndexedDB unavailable (private mode, disabled) — degrade to online-only
  }
}

/**
 * Drop every queued write.
 *
 * Entries are keyed by note id alone, with no owner recorded — which is exactly
 * why this exists. If one person signs out with unsent edits and another signs
 * in on the same browser, the replay would post those edits into the *new*
 * user's vault. Sign-out must therefore discard the queue, even though that
 * means losing edits that never reached the server.
 */
export async function clearWrites(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
  } catch {
    /* IndexedDB unavailable — nothing was queued to begin with */
  }
}
