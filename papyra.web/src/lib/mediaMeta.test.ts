import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaMetaStore, mediaUrl, snapThumbWidth, toMediaMeta } from './mediaMeta';

// Embeds read metadata synchronously during render (useSyncExternalStore), so
// the store must batch misses into one request, hand back the *same* object
// for the same file, and never leave a file waiting forever.

const server = {
  'a.png': { name: 'a.png', kind: 'image', size: 10, version: 'v1a', width: 800, height: 600, thumb: true, animated: false, poster: false, durationMs: null },
  'b.gif': { name: 'b.gif', kind: 'gif', size: 20, version: 'v2b', width: 10, height: 10, thumb: true, animated: true, poster: false, durationMs: null },
  'gone.png': null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const { names } = JSON.parse(String(init?.body)) as { names: string[] };
    return json(Object.fromEntries(names.map((n) => [n, (server as Record<string, unknown>)[n] ?? null])));
  });
});
afterEach(() => { vi.useRealTimers(); });

async function settle() {
  await vi.advanceTimersByTimeAsync(50);
}

describe('media metadata store', () => {
  it('batches every miss in one tick into one request', async () => {
    const store = createMediaMetaStore('/api/media', fetcher as unknown as typeof fetch);
    expect(store.get('a.png')).toBeUndefined();
    expect(store.get('b.gif')).toBeUndefined();
    expect(store.get('a.png')).toBeUndefined(); // still one entry
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/media/meta');
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).names).toEqual(['a.png', 'b.gif']);
  });

  it('returns the same object until it changes, and notifies once per batch', async () => {
    const store = createMediaMetaStore('/api/media', fetcher as unknown as typeof fetch);
    const listener = vi.fn();
    store.subscribe(listener);
    store.get('a.png');
    store.get('b.gif');
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    const first = store.get('a.png');
    expect(first).toMatchObject({ kind: 'image', width: 800, height: 600, thumb: true, version: 'v1a' });
    expect(store.get('a.png')).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records "none" for a file the server has nothing on, and asks again later', async () => {
    const store = createMediaMetaStore('/api/media', fetcher as unknown as typeof fetch);
    store.get('gone.png');
    await settle();
    expect(store.get('gone.png')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.get('gone.png')).toBeNull(); // re-asked in the background
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back to "none" (originals) when the lookup fails', async () => {
    const failing = vi.fn(async () => { throw new TypeError('offline'); });
    const store = createMediaMetaStore('/api/media', failing as unknown as typeof fetch);
    store.get('a.png');
    await settle();
    expect(store.get('a.png')).toBeNull();

    const erroring = vi.fn(async () => json({ error: 'x' }, 500));
    const other = createMediaMetaStore('/api/media', erroring as unknown as typeof fetch);
    other.get('a.png');
    await settle();
    expect(other.get('a.png')).toBeNull();
  });

  it('splits more than 200 names across requests', async () => {
    const store = createMediaMetaStore('/api/media', fetcher as unknown as typeof fetch);
    for (let i = 0; i < 450; i++) store.get(`f${i}.png`);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('prime() stores an upload\'s metadata without a request', () => {
    const store = createMediaMetaStore('/api/media', fetcher as unknown as typeof fetch);
    const listener = vi.fn();
    store.subscribe(listener);
    store.prime('new.png', { kind: 'image', width: 5, height: 5 });
    expect(store.get('new.png')).toMatchObject({ width: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('toMediaMeta', () => {
  it('maps the server shape and drops junk', () => {
    expect(toMediaMeta(null)).toBeNull();
    expect(toMediaMeta({ kind: 'video', width: 'wide', poster: true, durationMs: 1200 }))
      .toMatchObject({ kind: 'video', width: null, poster: true, durationMs: 1200, thumb: false });
  });
});

describe('mediaUrl', () => {
  const meta = { version: 'abc123' };
  it('points originals at the file', () => {
    expect(mediaUrl('/api/media', 'my photo.png')).toBe('/api/media/my%20photo.png');
    expect(mediaUrl('/api/shared/tok/media', 'a.png', { variant: 'original' })).toBe('/api/shared/tok/media/a.png');
  });

  it('versions thumbnails and posters, snapped to the server buckets', () => {
    expect(mediaUrl('/api/media', 'a.png', { variant: 'thumb', width: 500 }, meta)).toBe('/api/media/a.png/thumb?w=640&v=abc123');
    expect(mediaUrl('/api/media', 'v.mp4', { variant: 'poster', width: 1280 }, meta)).toBe('/api/media/v.mp4/thumb?w=1280&v=abc123');
    expect(mediaUrl('/api/shares/incoming/4/media', 'a.png', { variant: 'thumb', width: 320 })).toBe('/api/shares/incoming/4/media/a.png/thumb?w=320');
  });

  it('snaps widths', () => {
    expect([undefined, 1, 160, 161, 640, 5000].map(snapThumbWidth)).toEqual([320, 160, 160, 320, 640, 1280]);
  });
});
