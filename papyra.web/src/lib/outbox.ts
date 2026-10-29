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
  /** Omitted leaves the note's lock state alone, matching the API. */
  secure?: boolean;
}

export interface OutboxEntry {
  id: string;
  payload: NoteWritePayload;
  /** `updated` of the server revision this edit was based on (ISO), if known. */
  base?: string;
  /** When the edit was queued (ISO) — surfaced in the UI. */
  queuedAt: string;
  /**
   * Written from a live (collaborative) editor: only the metadata is the
   * writer's — the body belongs to the room, so the server keeps its own.
   */
  collab?: boolean;
  /**
   * The write replaces a revision its editor never adopted: the replay asks
   * the API to archive that revision first (see notesApi SNAPSHOT_HEADER).
   */
  forceSnapshot?: boolean;
}

const DB_NAME = 'papyra-outbox';
// 2 adds the journal's own store; the note store is untouched.
const DB_VERSION = 2;
const STORE = 'writes';
const JOURNAL_STORE = 'journal-writes';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) db.createObjectStore(JOURNAL_STORE, { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
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
    const notes = await tx<number>('readonly', (s) => s.count() as IDBRequest<number>);
    const days = await tx<number>('readonly', (s) => s.count() as IDBRequest<number>, JOURNAL_STORE);
    return notes + days;
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
    await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>, JOURNAL_STORE);
  } catch {
    /* IndexedDB unavailable — nothing was queued to begin with */
  }
}

// ── The journal's queue ───────────────────────────────────────────────────────
// One entry per day, keyed by its date: a day only ever needs its LATEST text,
// so queuing the same day again replaces the earlier entry. `baseHash` is the
// hash of the body the edit started from (the ETag the day was read with), so a
// replay can tell when another device wrote that day meanwhile.

export interface JournalWriteEntry {
  date: string;
  /** Absent fields keep what the server has. */
  patch: { body?: string; mood?: number | null; tags?: string[] };
  /** The ETag (body hash) this edit was made against, if the day existed. */
  baseHash?: string;
  queuedAt: string;
}

export async function queueJournalWrite(entry: JournalWriteEntry): Promise<void> {
  // A newer edit to the same day replaces the queued one but keeps its fields:
  // a mood tapped offline must survive the text typed after it.
  const prior = await pendingJournalWrite(entry.date).catch(() => undefined);
  const merged: JournalWriteEntry = prior
    ? { ...entry, patch: { ...prior.patch, ...entry.patch }, baseHash: prior.baseHash ?? entry.baseHash }
    : entry;
  await tx('readwrite', (s) => s.put(merged) as IDBRequest<IDBValidKey>, JOURNAL_STORE);
}

export async function pendingJournalWrites(): Promise<JournalWriteEntry[]> {
  const all = await tx<JournalWriteEntry[]>('readonly', (s) => s.getAll() as IDBRequest<JournalWriteEntry[]>, JOURNAL_STORE);
  return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function pendingJournalWrite(date: string): Promise<JournalWriteEntry | undefined> {
  return tx<JournalWriteEntry | undefined>('readonly', (s) => s.get(date) as IDBRequest<JournalWriteEntry | undefined>, JOURNAL_STORE);
}

export async function removeJournalWrite(date: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(date) as IDBRequest<undefined>, JOURNAL_STORE);
}
