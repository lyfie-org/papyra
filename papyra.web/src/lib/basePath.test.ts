// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseFromDocument, installBasePath, isUnderBase, prefixAny, prefixOwn, prefixSrcset, stripBase } from './basePath';

describe('baseFromDocument', () => {
  const doc = (content: string | null) => {
    const d = document.implementation.createHTMLDocument('t');
    if (content !== null) {
      const m = d.createElement('meta');
      m.setAttribute('name', 'papyra-base');
      m.setAttribute('content', content);
      d.head.appendChild(m);
    }
    return d;
  };

  it('is empty at the root', () => {
    expect(baseFromDocument(doc(null))).toBe('');
    expect(baseFromDocument(doc(''))).toBe('');
    expect(baseFromDocument(doc('/'))).toBe('');
    expect(baseFromDocument(undefined)).toBe('');
  });

  it('reads the base the server wrote', () => {
    expect(baseFromDocument(doc('/papyra'))).toBe('/papyra');
    expect(baseFromDocument(doc('/apps/papyra/'))).toBe('/apps/papyra');
  });
});

describe('prefixing', () => {
  const host = 'notes.example.com';

  it('does nothing at the root', () => {
    expect(prefixOwn('/api/notes', '', host)).toBe('/api/notes');
    expect(prefixAny('/login', '')).toBe('/login');
  });

  it('prefixes Papyra roots and leaves everything else', () => {
    expect(prefixOwn('/api/notes?x=1', '/p', host)).toBe('/p/api/notes?x=1');
    expect(prefixOwn('/hubs/notes', '/p', host)).toBe('/p/hubs/notes');
    expect(prefixOwn('/collab/room', '/p', host)).toBe('/p/collab/room');
    expect(prefixOwn('/assets/a.js', '/p', host)).toBe('/p/assets/a.js');
    expect(prefixOwn('/fonts/fonts.css', '/p', host)).toBe('/p/fonts/fonts.css');
    expect(prefixOwn('/favicon.ico', '/p', host)).toBe('/p/favicon.ico');
    expect(prefixOwn('/sw.js', '/p', host)).toBe('/p/sw.js');
  });

  it('leaves a link to something else on the same host alone', () => {
    expect(prefixOwn('/grafana/d/1', '/p', host)).toBe('/grafana/d/1');
    expect(prefixOwn('/apiary', '/p', host)).toBe('/apiary');
    expect(prefixOwn('/docs/', '/p', host)).toBe('/docs/');
  });

  it('is idempotent', () => {
    const once = prefixOwn('/api/notes', '/p', host);
    expect(prefixOwn(once, '/p', host)).toBe(once);
    expect(prefixAny(prefixAny('/login', '/p'), '/p')).toBe('/p/login');
  });

  it('does not mistake a longer sibling for the base', () => {
    expect(isUnderBase('/papyra2/api', '/papyra')).toBe(false);
    expect(prefixOwn('/papyra2/api', '/papyra', host)).toBe('/papyra2/api');
    expect(prefixAny('/papyra2', '/papyra')).toBe('/papyra/papyra2');
  });

  it('handles same-host absolute and websocket URLs, and no others', () => {
    expect(prefixOwn(`https://${host}/api/notes`, '/p', host)).toBe(`https://${host}/p/api/notes`);
    expect(prefixOwn(`wss://${host}/hubs/notes?id=1`, '/p', host)).toBe(`wss://${host}/p/hubs/notes?id=1`);
    expect(prefixOwn(`https://${host}/p/api/notes`, '/p', host)).toBe(`https://${host}/p/api/notes`);
    expect(prefixOwn('https://other.example/api/notes', '/p', host)).toBe('https://other.example/api/notes');
    expect(prefixOwn('//other.example/api/notes', '/p', host)).toBe('//other.example/api/notes');
  });

  it('leaves relative, blob, data and mailto URLs alone', () => {
    for (const url of ['api/notes', './api', 'blob:https://x/1', 'data:image/png;base64,AA', 'mailto:a@b.c', '#top', '?q=1']) {
      expect(prefixOwn(url, '/p', host)).toBe(url);
    }
  });

  it('prefixes a navigation to the app itself', () => {
    expect(prefixAny('/', '/p')).toBe('/p/');
    expect(prefixAny('/login?sso=1', '/p')).toBe('/p/login?sso=1');
    expect(prefixAny('https://x.example/', '/p')).toBe('https://x.example/');
    expect(prefixAny('//x.example/', '/p')).toBe('//x.example/');
  });

  it('prefixes every candidate of a srcset', () => {
    expect(prefixSrcset('/api/media/a.png/thumb?w=160 160w, /api/media/a.png/thumb?w=320 320w', '/p', host))
      .toBe('/p/api/media/a.png/thumb?w=160 160w, /p/api/media/a.png/thumb?w=320 320w');
    expect(prefixSrcset('https://cdn.example/a.png 1x, /grafana/x.png 2x', '/p', host)).toBe('https://cdn.example/a.png 1x, /grafana/x.png 2x');
    expect(prefixSrcset('/api/media/a.png', '', host)).toBe('/api/media/a.png');
  });

  it('strips the base back off a path', () => {
    expect(stripBase('/p/shared/abc', '/p')).toBe('/shared/abc');
    expect(stripBase('/p', '/p')).toBe('/');
    expect(stripBase('/other', '/p')).toBe('/other');
    expect(stripBase('/shared/abc', '')).toBe('/shared/abc');
  });
});

describe('installBasePath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeWindow() {
    const calls: { fetch: unknown[]; open: unknown[]; sockets: string[] } = { fetch: [], open: [], sockets: [] };
    class FakeSocket {
      constructor(url: string) { calls.sockets.push(url); }
    }
    class FakeXhr {
      open(...args: unknown[]) { calls.open.push(args); }
    }
    class FakeElement {
      attrs = new Map<string, string>();
      setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    }
    class FakeImage {
      private v = '';
      get src() { return this.v; }
      set src(value: string) { this.v = value; }
    }
    class FakeObserver {
      observe() {}
    }
    const win = {
      location: { host: 'notes.example.com' },
      fetch: (...args: unknown[]) => { calls.fetch.push(args); return Promise.resolve(new Response('')); },
      XMLHttpRequest: FakeXhr,
      WebSocket: FakeSocket,
      Element: FakeElement,
      HTMLImageElement: FakeImage,
      MutationObserver: FakeObserver,
      open: (...args: unknown[]) => { calls.open.push(['window.open', ...args]); return null; },
      navigator: {},
      document: { documentElement: {} },
    };
    return { win: win as unknown as Parameters<typeof installBasePath>[1], raw: win, calls };
  }

  it('does nothing at the root', () => {
    const { win, raw } = fakeWindow();
    const before = raw.fetch;
    installBasePath('', win);
    expect(raw.fetch).toBe(before);
  });

  it('prefixes fetch, XHR, WebSocket, window.open, attributes and src setters', async () => {
    const { win, raw, calls } = fakeWindow();
    installBasePath('/p', win);

    await raw.fetch('/api/notes', { method: 'POST' });
    await raw.fetch('/grafana/x');
    expect(calls.fetch[0]).toEqual(['/p/api/notes', { method: 'POST' }]);
    expect(calls.fetch[1]).toEqual(['/grafana/x', undefined]);

    new raw.XMLHttpRequest().open('GET', '/api/auth/me', true);
    expect(calls.open[0]).toEqual(['GET', '/p/api/auth/me', true]);

    new raw.WebSocket('wss://notes.example.com/hubs/notes?id=1');
    new raw.WebSocket('wss://elsewhere.example/hubs/notes');
    expect(calls.sockets).toEqual(['wss://notes.example.com/p/hubs/notes?id=1', 'wss://elsewhere.example/hubs/notes']);

    raw.open('/api/media/a.pdf', '_blank');
    expect(calls.open[1]).toEqual(['window.open', '/p/api/media/a.pdf', '_blank', undefined]);

    const el = new raw.Element();
    el.setAttribute('src', '/api/media/a.png');
    el.setAttribute('href', '/note/1');
    el.setAttribute('class', '/api/x');
    el.setAttribute('srcset', '/api/media/c.png/thumb?w=160 160w, /api/media/c.png/thumb?w=320 320w');
    expect(el.attrs.get('srcset')).toBe('/p/api/media/c.png/thumb?w=160 160w, /p/api/media/c.png/thumb?w=320 320w');
    expect(el.attrs.get('src')).toBe('/p/api/media/a.png');
    expect(el.attrs.get('href')).toBe('/note/1');
    expect(el.attrs.get('class')).toBe('/api/x');

    const img = new raw.HTMLImageElement();
    img.src = '/api/media/b.png';
    expect(img.src).toBe('/p/api/media/b.png');
  });

  it('installs once', () => {
    const { win, raw } = fakeWindow();
    installBasePath('/p', win);
    const wrapped = raw.fetch;
    installBasePath('/p', win);
    expect(raw.fetch).toBe(wrapped);
  });
});
