// The one seam every journal request goes through. Reads are plain fetches (the
// day you were writing offline is laid back over the server's copy); a write is
// a PUT online and a durable queue entry offline — the same promise the notes
// outbox makes: a disconnection never costs a keystroke.

import type {
  JournalEntry, JournalPatch, JournalPrefs, JournalPrefsPatch, JournalRange, JournalStats, JournalSummary, JournalTemplate, JournalToday,
} from '../types/journal';
import {
  pendingJournalWrite, pendingJournalWrites, queueJournalWrite, removeJournalWrite,
} from './outbox';
import { getSyncState, refreshPending, setSync } from './syncStatus';

/** A real API refusal (not "can't reach the server"): the caller's problem. */
export class JournalError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'JournalError';
    this.status = status;
    this.code = code;
  }
}

const SAVE_TIMEOUT_MS = 8_000;
const SNAPSHOT_HEADER = 'X-Papyra-Snapshot';
const UNLOCK_HEADER = 'X-Unlock-Token';

/** Statuses a replay can never fix: the queued write is dropped rather than wedging the queue. */
const DISCARDABLE = new Set([400, 404, 410, 413, 422]);

async function refusal(res: Response): Promise<JournalError> {
  const data = (await res.clone().json().catch(() => null)) as { error?: string; code?: string } | null;
  return new JournalError(res.status, data?.code ?? null, data?.error ?? `The journal answered ${res.status}.`);
}

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

function unreachable(res?: Response): boolean {
  return !navigator.onLine || !res || res.status === 502 || res.status === 503 || res.status === 504;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function fetchToday(): Promise<JournalToday> {
  const res = await fetch('/api/journal/today');
  setSync({ online: res.headers.get('X-Papyra-Cache') !== 'hit' });
  const today = await read<JournalToday>(res);
  return { ...today, entry: await withQueued(today.entry) };
}

export interface LoadedEntry {
  entry: JournalEntry;
  /** Names the body (its hash): what a save sends back as If-Match. */
  etag: string | null;
}

export async function fetchEntry(date: string, unlockToken?: string | null): Promise<LoadedEntry> {
  const res = await fetch(`/api/journal/${date}`, unlockToken ? { headers: { [UNLOCK_HEADER]: unlockToken } } : undefined);
  const entry = await read<JournalEntry>(res);
  const etag = res.headers.get('ETag');
  return { entry: await withQueued(entry), etag };
}

/** Lay an unsent offline edit over what the server has, so the page shows the person's own latest text. */
async function withQueued(entry: JournalEntry): Promise<JournalEntry> {
  const queued = await pendingJournalWrite(entry.date).catch(() => undefined);
  if (!queued || entry.future) return entry;
  const { body, mood, tags } = queued.patch;
  return {
    ...entry,
    exists: true,
    body: body ?? entry.body,
    mood: (mood === undefined ? entry.mood : mood) as JournalEntry['mood'],
    tags: tags ?? entry.tags,
  };
}

export async function fetchRange(from: string, to: string): Promise<JournalRange> {
  return read<JournalRange>(await fetch(`/api/journal?from=${from}&to=${to}`));
}

export async function fetchStats(): Promise<JournalStats> {
  return read<JournalStats>(await fetch('/api/journal/stats'));
}

export async function fetchOnThisDay(date: string): Promise<JournalSummary[]> {
  const data = await read<{ entries: JournalSummary[] }>(await fetch(`/api/journal/on-this-day?date=${date}`));
  return data.entries;
}

export async function fetchPrefs(): Promise<{ settings: JournalPrefs; pinSet: boolean }> {
  return read(await fetch('/api/journal/settings'));
}

export async function savePrefs(patch: JournalPrefsPatch): Promise<{ settings: JournalPrefs; pinSet: boolean }> {
  return read(await fetch('/api/journal/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }));
}

// ── Writes ────────────────────────────────────────────────────────────────────

export type SaveResult =
  | { status: 'saved'; entry: JournalEntry; etag: string | null }
  /** Parked in the offline queue; it uploads when the server is reachable. */
  | { status: 'queued' }
  /** Another device wrote this day first. `body` is what it holds now. */
  | { status: 'stale'; body: string; etag: string | null };

export interface SaveOptions {
  /** The ETag the day was read with — the revision this edit is made against. */
  baseHash?: string | null;
  /** Archive the revision this write replaces, even inside the history throttle. */
  forceSnapshot?: boolean;
  unlockToken?: string | null;
}

function hashOf(etag: string | null | undefined): string | undefined {
  return etag ? etag.replace(/^W\//, '').replace(/"/g, '') : undefined;
}

/**
 * Save a day. 'saved' when the API took it; 'queued' when it was parked for
 * later (offline, unreachable, session lapsed); 'stale' when the server moved on
 * (the caller decides — the editor shows the newer text and keeps the draft).
 * Throws a JournalError for a real refusal (a future day, a Trash day, a PIN not set…).
 */
export async function saveEntry(date: string, patch: JournalPatch, opts: SaveOptions = {}): Promise<SaveResult> {
  const baseHash = hashOf(opts.baseHash);
  const park = async (): Promise<SaveResult> => {
    // Only text, mood and tags wait offline: locking and archiving need the vault.
    const { body, mood, tags } = patch;
    await queueJournalWrite({
      date, patch: { ...(body !== undefined ? { body } : {}), ...(mood !== undefined ? { mood } : {}), ...(tags ? { tags } : {}) },
      baseHash, queuedAt: new Date().toISOString(),
    });
    await refreshPending();
    setSync({ online: false });
    return { status: 'queued' };
  };

  if (!navigator.onLine || !getSyncState().online) return park();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (baseHash && patch.body !== undefined) headers['If-Match'] = `"${baseHash}"`;
  if (opts.forceSnapshot) headers[SNAPSHOT_HEADER] = 'force';
  if (opts.unlockToken) headers[UNLOCK_HEADER] = opts.unlockToken;

  let res: Response;
  try {
    res = await fetch(`/api/journal/${date}`, {
      method: 'PUT', headers, body: JSON.stringify(patch), signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch {
    return park();
  }

  if (res.status === 412) {
    const data = (await res.json().catch(() => null)) as { body?: string; etag?: string } | null;
    return { status: 'stale', body: data?.body ?? '', etag: data?.etag ?? res.headers.get('ETag') };
  }
  if (!res.ok) {
    const err = await refusal(res);
    // A day that can't be written (future, in Trash, PIN not set, vault closed) is the
    // caller's to explain; a server that can't be reached, a lapsed session or a
    // hiccup is not a reason to lose the text.
    const callerProblem = DISCARDABLE.has(res.status) || res.status === 409 || res.status === 423
      || (res.status === 401 && err.code === 'locked');
    if (callerProblem && !unreachable(res)) throw err;
    if (res.status === 401 || res.status === 403) setSync({ authRequired: true });
    return park();
  }

  // The server has this day now: a queued copy would only overwrite it later.
  await removeJournalWrite(date).catch(() => undefined);
  await refreshPending();
  if (!getSyncState().online) setSync({ online: true });
  return { status: 'saved', entry: (await res.json()) as JournalEntry, etag: res.headers.get('ETag') };
}

/** Append text to a day (the same call an agent on a key makes). */
export async function appendToDay(date: string, text: string, heading?: string): Promise<JournalEntry> {
  return read<JournalEntry>(await fetch(`/api/journal/${date}/append`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, heading }),
  }));
}

/**
 * Replay the journal queue, oldest first. A day another device wrote meanwhile
 * (412) is overwritten by the queued text — last write wins, but the server
 * archives the newer revision first, so nothing is lost — and reported.
 */
export async function flushJournalOutbox(): Promise<{ synced: number; conflicts: string[] }> {
  const queued = await pendingJournalWrites().catch(() => []);
  if (queued.length === 0) return { synced: 0, conflicts: [] };
  setSync({ syncing: true });
  const conflicts: string[] = [];
  let synced = 0;

  for (const entry of queued) {
    const send = (ifMatch: string | undefined, force: boolean) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ifMatch && entry.patch.body !== undefined) headers['If-Match'] = `"${ifMatch}"`;
      if (force) headers[SNAPSHOT_HEADER] = 'force';
      return fetch(`/api/journal/${entry.date}`, { method: 'PUT', headers, body: JSON.stringify(entry.patch) });
    };
    let res: Response;
    try {
      res = await send(entry.baseHash, false);
      if (res.status === 412) {
        res = await send(undefined, true);
        if (res.ok) conflicts.push(entry.date);
      }
    } catch {
      setSync({ syncing: false, online: false });
      await refreshPending();
      return { synced, conflicts };
    }
    if (!res.ok) {
      if (unreachable(res)) {
        setSync({ syncing: false, online: false });
        await refreshPending();
        return { synced, conflicts };
      }
      // A day that went to the Trash (or can't be written yet) keeps its text queued
      // — restoring the day lets it land — without holding up the days behind it.
      if (res.status === 409) continue;
      // A session that lapsed, a server hiccup: keep the text, try again later.
      if (!DISCARDABLE.has(res.status)) {
        setSync({ syncing: false, authRequired: res.status === 401 || res.status === 403 });
        await refreshPending();
        return { synced, conflicts };
      }
      await removeJournalWrite(entry.date);
      continue;
    }
    await removeJournalWrite(entry.date);
    synced += 1;
  }
  await refreshPending();
  setSync({ syncing: false, online: true });
  return { synced, conflicts };
}

/** Seal every day that isn't (Settings → Journal). Needs a vault PIN; the person's, never a key's. */
export async function lockAllEntries(): Promise<{ locked: number }> {
  return read(await fetch('/api/journal/lock-all', { method: 'POST' }));
}

// ── Days set aside, and the pages a day can start from ────────────────────────

export async function fetchBin(state: 'archived' | 'trashed' | 'locked'): Promise<JournalSummary[]> {
  const data = await read<{ entries: JournalSummary[] }>(await fetch(`/api/journal/bin?state=${state}`));
  return data.entries;
}

/** Bring a day back from the Archive or the Trash. */
export async function restoreDay(date: string, from: 'archived' | 'trashed'): Promise<void> {
  const res = from === 'trashed'
    ? await fetch(`/api/notes/journal-${date}/untrash`, { method: 'POST' })
    : await fetch(`/api/journal/${date}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }),
    });
  if (!res.ok) throw await refusal(res);
}

export async function fetchTemplates(): Promise<{ templates: JournalTemplate[]; defaultTemplate: string | null }> {
  return read(await fetch('/api/journal/templates'));
}

export async function saveTemplate(name: string, body: string): Promise<JournalTemplate> {
  return read(await fetch(`/api/journal/templates/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
  }));
}

export async function deleteTemplate(name: string): Promise<void> {
  const res = await fetch(`/api/journal/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw await refusal(res);
}
