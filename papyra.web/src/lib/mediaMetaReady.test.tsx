// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMediaMetaReady } from './mediaMeta';

// The editor mounts behind this gate, so an embed never renders before its
// metadata (and starts downloading the full-size original). It must ask for
// every attachment in one request — a short-circuiting check once asked for one
// name per round trip, 26 of them in a row for a 200-picture note.

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useMediaMetaReady', () => {
  it('asks for every attachment in one batch, then opens', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const { names } = JSON.parse(String(init?.body)) as { names: string[] };
      return new Response(JSON.stringify(Object.fromEntries(names.map((n) => [n, { kind: 'image', width: 10, height: 10 }]))));
    });
    vi.stubGlobal('fetch', fetcher);
    const body = '![[a.png]] text ![[b.jpg|300]] [[A note]] ![[c.pdf#page=2]]';
    const { result } = renderHook(() => useMediaMetaReady(body, '/api/test-one-batch'));
    expect(result.current).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(result.current).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body)).names).toEqual(['a.png', 'b.jpg', 'c.pdf']);
  });

  it('opens at once for a note with no attachments', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderHook(() => useMediaMetaReady('just words [[A note]]', '/api/test-none'));
    expect(result.current).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up waiting after a second (slow server): the editor still opens', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => useMediaMetaReady('![[slow.png]]', '/api/test-slow'));
    expect(result.current).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current).toBe(true);
  });
});
