// ── Offline mutation queue — IndexedDB-backed ─────────────────────────────
//
// Stores note update requests that couldn't be sent while offline.
// The OfflineQueueContext replays them in FIFO order on reconnect.

const DB_NAME  = 'papyra-offline';
const DB_VER   = 1;
const STORE    = 'mutations';

export interface QueuedMutation {
  /** Unique queue-entry id (not the note id) */
  id: string;
  noteId: string;
  req: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: number;
}

let _db: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result
        .createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
  return _db;
}

export async function enqueueDb(mutation: QueuedMutation): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(mutation);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function dequeueDb(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function listQueueDb(): Promise<QueuedMutation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedMutation[]);
    req.onerror   = () => reject(req.error);
  });
}
