import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalWriteEntry } from './outbox';

// The outbox is IndexedDB; here it is a Map, so the queueing rules are what's tested.
const queue = new Map<string, JournalWriteEntry>();
vi.mock('./outbox', () => ({
  queueJournalWrite: vi.fn(async (e: JournalWriteEntry) => {
    const prior = queue.get(e.date);
    queue.set(e.date, prior ? { ...e, patch: { ...prior.patch, ...e.patch }, baseHash: prior.baseHash ?? e.baseHash } : e);
  }),
  pendingJournalWrite: vi.fn(async (d: string) => queue.get(d)),
  pendingJournalWrites: vi.fn(async () => [...queue.values()]),
  removeJournalWrite: vi.fn(async (d: string) => { queue.delete(d); }),
  countWrites: vi.fn(async () => queue.size),
}));

import { fetchEntry, flushJournalOutbox, JournalError, saveEntry } from './journalApi';
import { setSync } from './syncStatus';

const entry = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-25', id: 'journal-2026-10-25', exists: true, future: false, today: '2026-10-25',
  body: 'server text', mood: null, tags: [], archived: false, locked: false, trashed: false, words: 2, updated: null,
  ...over,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queue.clear();
  setSync({ online: true, pending: 0, authRequired: false, syncing: false });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('saveEntry', () => {
  it('PUTs the patch and names the revision it was made against', async () => {
    fetchMock.mockResolvedValue(json(entry({ body: 'new' }), { headers: { 'Content-Type': 'application/json', ETag: '"def"' } }));
    const result = await saveEntry('2026-10-25', { body: 'new' }, { baseHash: '"abc"' });
    expect(result.status).toBe('saved');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/journal/2026-10-25');
    expect(init.method).toBe('PUT');
    expect(init.headers['If-Match']).toBe('"abc"');
    expect(JSON.parse(init.body)).toEqual({ body: 'new' });
    expect(result.status === 'saved' && result.etag).toBe('"def"');
  });

  it('sends no If-Match for a change that leaves the text alone (a mood tap)', async () => {
    fetchMock.mockResolvedValue(json(entry({ mood: 4 })));
    await saveEntry('2026-10-25', { mood: 4 }, { baseHash: 'abc' });
    expect(fetchMock.mock.calls[0][1].headers['If-Match']).toBeUndefined();
  });

  it('reports a day another device wrote first, and does not queue it', async () => {
    fetchMock.mockResolvedValue(json({ code: 'stale', body: 'theirs', etag: '"zzz"' }, { status: 412 }));
    const result = await saveEntry('2026-10-25', { body: 'mine' }, { baseHash: 'abc' });
    expect(result).toEqual({ status: 'stale', body: 'theirs', etag: '"zzz"' });
    expect(queue.size).toBe(0);
  });

  it('parks the text when the network refuses — a disconnection never costs a keystroke', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await saveEntry('2026-10-25', { body: 'written on a train' }, { baseHash: 'abc' });
    expect(result.status).toBe('queued');
    expect(queue.get('2026-10-25')?.patch.body).toBe('written on a train');
    expect(queue.get('2026-10-25')?.baseHash).toBe('abc');
  });

  it('parks straight away when already known to be offline', async () => {
    setSync({ online: false });
    expect((await saveEntry('2026-10-25', { body: 'x' })).status).toBe('queued');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a mood tapped offline when text is typed after it', async () => {
    setSync({ online: false });
    await saveEntry('2026-10-25', { mood: 2 });
    await saveEntry('2026-10-25', { body: 'later text' });
    expect(queue.get('2026-10-25')?.patch).toEqual({ mood: 2, body: 'later text' });
  });

  it('parks on a lapsed session or a server error, but explains a refusal', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'sign in' }, { status: 401 }));
    expect((await saveEntry('2026-10-25', { body: 'x' })).status).toBe('queued');
    setSync({ online: true });
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, { status: 500 }));
    expect((await saveEntry('2026-10-24', { body: 'y' })).status).toBe('queued');

    setSync({ online: true }); // a parked write marks the app offline until the engine retries
    fetchMock.mockResolvedValueOnce(json({ error: 'A journal day can’t be written before it begins.', code: 'future_date' }, { status: 422 }));
    await expect(saveEntry('2030-01-01', { body: 'z' })).rejects.toMatchObject({ code: 'future_date', status: 422 });
    setSync({ online: true });
    fetchMock.mockResolvedValueOnce(json({ error: 'in the Trash', code: 'trashed' }, { status: 409 }));
    await expect(saveEntry('2026-10-23', { body: 'z' })).rejects.toBeInstanceOf(JournalError);
    expect(queue.has('2030-01-01')).toBe(false);
  });

  it('drops a queued copy once the server has the day', async () => {
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'old offline' }, queuedAt: 'x' });
    fetchMock.mockResolvedValue(json(entry()));
    await saveEntry('2026-10-25', { body: 'now online' });
    expect(queue.size).toBe(0);
  });
});

describe('fetchEntry', () => {
  it('lays an unsent offline edit over what the server has', async () => {
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'my offline words', mood: 5 }, queuedAt: 'x' });
    fetchMock.mockResolvedValue(json(entry(), { headers: { 'Content-Type': 'application/json', ETag: '"abc"' } }));
    const { entry: shown, etag } = await fetchEntry('2026-10-25');
    expect(shown.body).toBe('my offline words');
    expect(shown.mood).toBe(5);
    expect(shown.exists).toBe(true);
    expect(etag).toBe('"abc"');
  });

  it('never lays a queued edit over a future day', async () => {
    queue.set('2030-01-01', { date: '2030-01-01', patch: { body: 'x' }, queuedAt: 'x' });
    fetchMock.mockResolvedValue(json(entry({ date: '2030-01-01', future: true, exists: false, body: '' })));
    expect((await fetchEntry('2030-01-01')).entry.body).toBe('');
  });
});

describe('flushJournalOutbox', () => {
  it('replays queued days oldest first and empties the queue', async () => {
    queue.set('2026-10-24', { date: '2026-10-24', patch: { body: 'a' }, queuedAt: '1' });
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'b' }, queuedAt: '2' });
    fetchMock.mockResolvedValue(json(entry()));
    expect(await flushJournalOutbox()).toEqual({ synced: 2, conflicts: [] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/journal/2026-10-24', '/api/journal/2026-10-25']);
    expect(queue.size).toBe(0);
  });

  it('when a day moved on meanwhile, the queued text wins but the newer one is archived first', async () => {
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'offline' }, baseHash: 'old', queuedAt: '1' });
    fetchMock
      .mockResolvedValueOnce(json({ code: 'stale', body: 'other device', etag: '"n"' }, { status: 412 }))
      .mockResolvedValueOnce(json(entry({ body: 'offline' })));
    const result = await flushJournalOutbox();
    expect(result).toEqual({ synced: 1, conflicts: ['2026-10-25'] });
    const retry = fetchMock.mock.calls[1][1];
    expect(retry.headers['If-Match']).toBeUndefined();
    expect(retry.headers['X-Papyra-Snapshot']).toBe('force');
  });

  it('stops when the server is unreachable and keeps everything queued', async () => {
    queue.set('2026-10-24', { date: '2026-10-24', patch: { body: 'a' }, queuedAt: '1' });
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'b' }, queuedAt: '2' });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await flushJournalOutbox()).toEqual({ synced: 0, conflicts: [] });
    expect(queue.size).toBe(2);
  });

  it('keeps the text of a day that went to the Trash, and carries on with the rest', async () => {
    queue.set('2026-10-24', { date: '2026-10-24', patch: { body: 'trashed day' }, queuedAt: '1' });
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'fine' }, queuedAt: '2' });
    fetchMock
      .mockResolvedValueOnce(json({ code: 'trashed' }, { status: 409 }))
      .mockResolvedValueOnce(json(entry()));
    expect((await flushJournalOutbox()).synced).toBe(1);
    expect([...queue.keys()]).toEqual(['2026-10-24']);
  });

  it('keeps everything when the session has lapsed', async () => {
    queue.set('2026-10-25', { date: '2026-10-25', patch: { body: 'b' }, queuedAt: '2' });
    fetchMock.mockResolvedValue(json({}, { status: 401 }));
    await flushJournalOutbox();
    expect(queue.size).toBe(1);
  });
});
