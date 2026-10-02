// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../types/note';
import type { OutboxEntry } from './outbox';

// A write that replaces a revision its editor never adopted asks the API to
// archive that revision first (`X-Papyra-Snapshot: force`), past the snapshot
// throttle that would otherwise fold it away for good.

const queue = new Map<string, OutboxEntry>();
let online = true;

vi.mock('./outbox', () => ({
  queueWrite: async (e: OutboxEntry) => { queue.set(e.id, e); },
  pendingWrite: async (id: string) => queue.get(id),
  pendingWrites: async () => [...queue.values()],
  removeWrite: async (id: string) => { queue.delete(id); },
}));
vi.mock('./syncStatus', () => ({
  refreshPending: async () => queue.size,
  setSync: () => {},
  getSyncState: () => ({ online, conflicts: [] }),
}));

const { putNote, flushOutbox, SNAPSHOT_HEADER } = await import('./notesApi');

const payload = {
  title: 'Plan', tags: [], color: null, pinned: false, archived: false, kind: 'note' as const, body: 'mine',
};

let forced: Array<{ url: string; force: boolean }>;
function stubFetch(notes: Partial<Note>[] = []) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/notes') return new Response(JSON.stringify(notes), { status: 200 });
    forced.push({ url, force: (init?.headers as Record<string, string>)[SNAPSHOT_HEADER] === 'force' });
    return new Response('{}', { status: 200 });
  });
}

beforeEach(() => {
  queue.clear();
  forced = [];
  online = true;
});
afterEach(() => vi.unstubAllGlobals());

describe('force-snapshot writes', () => {
  it('sends the header only when asked', async () => {
    stubFetch();
    await putNote('n1', payload);
    await putNote('n1', payload, undefined, { forceSnapshot: true });
    expect(forced.map((f) => f.force)).toEqual([false, true]);
  });

  it('keeps the request through the outbox, even when a later save replaces the entry', async () => {
    online = false;
    await putNote('n1', payload, '2026-10-01T00:00:00Z', { forceSnapshot: true });
    await putNote('n1', { ...payload, body: 'mine, more' }, '2026-10-01T00:00:00Z');
    expect(queue.get('n1')).toMatchObject({ forceSnapshot: true, payload: { body: 'mine, more' } });

    online = true;
    stubFetch([{ id: 'n1', updated: '2026-10-01T00:00:00Z' }]);
    await flushOutbox();
    expect(forced).toEqual([{ url: '/api/notes/n1', force: true }]);
  });

  it('replays an offline edit over a newer server revision with the header', async () => {
    queue.set('n1', { id: 'n1', payload, base: '2026-10-01T00:00:00Z', queuedAt: '2026-10-01T00:01:00Z' });
    queue.set('n2', { id: 'n2', payload, base: '2026-10-01T00:00:00Z', queuedAt: '2026-10-01T00:02:00Z' });
    stubFetch([
      { id: 'n1', updated: '2026-10-01T09:00:00Z' }, // moved on while we were away
      { id: 'n2', updated: '2026-10-01T00:00:00Z' },
    ]);
    await flushOutbox();
    expect(forced).toEqual([
      { url: '/api/notes/n1', force: true },
      { url: '/api/notes/n2', force: false },
    ]);
  });
});
