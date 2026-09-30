// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// public/sw.js is a classic worker script, not a module, so it is exercised the
// way a browser would: evaluated against a stand-in `self`, then fed events.
// The rule under test: only the app's own HTML may become the offline shell.
// An attachment opened in a tab, a download or an error page used to be saved
// as '/', replacing the app for every offline start after it.

type Listener = (event: unknown) => void;

function loadWorker(networkResponse: Response) {
  const listeners: Record<string, Listener> = {};
  const put = vi.fn(async () => {});
  const cache = { put, match: vi.fn(async () => undefined), addAll: vi.fn(async () => {}) };
  const context = {
    self: {
      addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
      location: { origin: 'https://papyra.test' },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: vi.fn(async () => networkResponse.clone()),
    URL,
    Response,
    Promise,
    console,
  };
  vm.runInNewContext(readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8'), context);

  async function navigate(path: string) {
    let responded: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: 'GET', mode: 'navigate', url: `https://papyra.test${path}` },
      respondWith: (p: Promise<Response>) => { responded = p; },
    });
    if (responded) await responded;
    await new Promise((r) => setTimeout(r, 0)); // let the cache write settle
    return { handled: responded !== undefined };
  }

  return { navigate, put };
}

const html = () => new Response('<!doctype html><div id="root"></div>', {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
});

describe('service worker shell cache', () => {
  it('keeps the app page as the offline shell', async () => {
    const sw = loadWorker(html());
    await sw.navigate('/notes/abc');
    expect(sw.put).toHaveBeenCalledTimes(1);
  });

  it('leaves API navigations (attachments, exports) to the browser', async () => {
    const sw = loadWorker(new Response('png', { headers: { 'content-type': 'image/png' } }));
    const { handled } = await sw.navigate('/api/media/photo-1a2b3c.png');
    expect(handled).toBe(false);
    expect(sw.put).not.toHaveBeenCalled();
  });

  it('never caches a download as the shell', async () => {
    const sw = loadWorker(new Response('<html>', {
      headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename=x.html' },
    }));
    await sw.navigate('/somewhere');
    expect(sw.put).not.toHaveBeenCalled();
  });

  it('never caches an error page or non-HTML as the shell', async () => {
    const error = loadWorker(new Response('<html>oops', { status: 502, headers: { 'content-type': 'text/html' } }));
    await error.navigate('/');
    expect(error.put).not.toHaveBeenCalled();

    const text = loadWorker(new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    await text.navigate('/');
    expect(text.put).not.toHaveBeenCalled();
  });
});
