// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEntry } from './outbox';

const queue = new Map<string, OutboxEntry>();

vi.mock('./outbox', () => ({
  queueWrite: async (e: OutboxEntry) => { queue.set(e.id, e); },
  pendingWrite: async (id: string) => queue.get(id),
  pendingWrites: async () => [...queue.values()],
  removeWrite: async (id: string) => { queue.delete(id); },
}));
vi.mock('./syncStatus', () => ({
  refreshPending: async () => queue.size,
  setSync: () => {},
  getSyncState: () => ({ online: true, conflicts: [] }),
}));

const { putNote, flushOutbox, COLLAB_HEADER } = await import('./notesApi');

const payload = {
  title: 'Plan', tags: [], color: null, pinned: false, archived: false, kind: 'note' as const, body: 'stale body',
};

const busy = () => new Response(JSON.stringify({ code: 'collab_active' }), {
  status: 409, headers: { 'Content-Type': 'application/json' },
});

describe('writes that lose to a live room', () => {
  let calls: Array<{ url: string; live: boolean }>;

  beforeEach(() => {
    queue.clear();
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler: (live: boolean, url: string) => Response) {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const live = !!(init?.headers as Record<string, string> | undefined)?.[COLLAB_HEADER];
      calls.push({ url, live });
      return handler(live, url);
    });
  }

  it('resends an interactive save as metadata-only instead of parking it forever', async () => {
    stubFetch((live) => (live ? new Response(null, { status: 204 }) : busy()));
    expect(await putNote('n1', payload)).toBe('saved');
    expect(calls.map((c) => c.live)).toEqual([false, true]);
    expect(queue.size).toBe(0);
  });

  it('replays a queued edit as metadata-only and reports the dropped body', async () => {
    queue.set('n1', { id: 'n1', payload, queuedAt: '2026-02-02T00:00:00Z' });
    stubFetch((live, url) => {
      if (url === '/api/notes') return new Response('[]', { status: 200 });
      return live ? new Response(null, { status: 204 }) : busy();
    });
    const { synced, conflicts } = await flushOutbox();
    expect(synced).toBe(1);
    expect(conflicts).toEqual(['Plan']);
    expect(queue.size).toBe(0);
  });

  it('still parks a save on an unrelated 409', async () => {
    stubFetch(() => new Response(JSON.stringify({ code: 'other' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    }));
    expect(await putNote('n1', payload)).toBe('queued');
    expect(queue.has('n1')).toBe(true);
  });
});
