const OWN_PATH =
  /^\/(?:(?:api|hubs|collab|assets|fonts)(?:[/?#]|$)|(?:sw\.js|site\.webmanifest|version\.json|icons\.svg|favicon[^/?#]*|apple-touch-icon[^/?#]*|android-chrome[^/?#]*)(?:[?#]|$))/;

const ABSOLUTE = /^(?:https?|wss?):\/\//i;

export function baseFromDocument(doc: Pick<Document, 'querySelector'> | undefined): string {
  const raw = doc?.querySelector('meta[name="papyra-base"]')?.getAttribute('content')?.trim() ?? '';
  if (raw === '' || raw === '/') return '';
  const lead = raw.startsWith('/') ? raw : `/${raw}`;
  return lead.replace(/\/+$/, '');
}

export function isUnderBase(path: string, base: string): boolean {
  if (base === '') return true;
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`);
}

function rootRelative(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

export function prefixAny(url: string, base: string): string {
  if (base === '' || !rootRelative(url) || isUnderBase(url, base)) return url;
  return base + url;
}

export function prefixOwn(url: string, base: string, host: string): string {
  if (base === '') return url;
  if (rootRelative(url)) return OWN_PATH.test(url) && !isUnderBase(url, base) ? base + url : url;
  if (!ABSOLUTE.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.host !== host) return url;
  if (!OWN_PATH.test(parsed.pathname) || isUnderBase(parsed.pathname, base)) return url;
  parsed.pathname = base + parsed.pathname;
  return parsed.toString();
}

export function prefixSrcset(value: string, base: string, host: string): string {
  if (base === '') return value;
  return value
    .split(',')
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return url ? [prefixOwn(url, base, host), ...descriptor].join(' ') : candidate;
    })
    .join(', ');
}

export function stripBase(path: string, base: string): string {
  if (base === '' || !isUnderBase(path, base)) return path;
  const rest = path.slice(base.length);
  return rest === '' ? '/' : rest;
}

export const BASE = baseFromDocument(typeof document === 'undefined' ? undefined : document);

export function withBase(url: string): string {
  return prefixAny(url, BASE);
}

export function ownUrl(url: string): string {
  return prefixOwn(url, BASE, typeof location === 'undefined' ? '' : location.host);
}

export function publicOrigin(): string {
  return `${location.origin}${BASE}`;
}

const URL_ATTRIBUTES = new Set(['src', 'srcset', 'href', 'poster', 'data', 'action']);

const URL_PROPERTIES: [string, string[]][] = [
  ['HTMLImageElement', ['src', 'srcset']],
  ['HTMLMediaElement', ['src']],
  ['HTMLSourceElement', ['src', 'srcset']],
  ['HTMLTrackElement', ['src']],
  ['HTMLIFrameElement', ['src']],
  ['HTMLEmbedElement', ['src']],
  ['HTMLObjectElement', ['data']],
  ['HTMLVideoElement', ['poster']],
  ['HTMLAnchorElement', ['href']],
  ['HTMLFormElement', ['action']],
];

type Win = Window & typeof globalThis & { __papyraBaseInstalled?: boolean };

export function installBasePath(base: string = BASE, target?: Win): void {
  const win = target ?? (typeof window === 'undefined' ? undefined : (window as Win));
  if (!win || base === '' || win.__papyraBaseInstalled) return;
  win.__papyraBaseInstalled = true;
  const host = win.location.host;
  const own = (url: string) => prefixOwn(url, base, host);
  const ownValue = (name: string, value: string) =>
    name.toLowerCase() === 'srcset' ? prefixSrcset(value, base, host) : own(value);

  const nativeFetch = win.fetch.bind(win);
  win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(own(input), init);
    if (input instanceof URL) return nativeFetch(own(input.href), init);
    const next = own(input.url);
    return nativeFetch(next === input.url ? input : new Request(next, input), init);
  };

  const nativeOpen = win.XMLHttpRequest.prototype.open as (...args: unknown[]) => void;
  win.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    nativeOpen.call(this, method, typeof url === 'string' ? own(url) : own(url.href), ...rest);
  } as typeof win.XMLHttpRequest.prototype.open;

  const NativeSocket = win.WebSocket;
  class BasedSocket extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(own(typeof url === 'string' ? url : url.href), protocols);
    }
  }
  win.WebSocket = BasedSocket;

  if (typeof win.EventSource === 'function') {
    const NativeSource = win.EventSource;
    class BasedSource extends NativeSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(own(typeof url === 'string' ? url : url.href), init);
      }
    }
    win.EventSource = BasedSource;
  }

  if (typeof win.navigator.sendBeacon === 'function') {
    const nativeBeacon = win.navigator.sendBeacon.bind(win.navigator);
    win.navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => nativeBeacon(own(typeof url === 'string' ? url : url.href), data);
  }

  const nativeWindowOpen = win.open.bind(win);
  win.open = (url?: string | URL, target?: string, features?: string) =>
    nativeWindowOpen(typeof url === 'string' ? own(url) : url instanceof URL ? own(url.href) : url, target, features);

  const nativeSetAttribute = win.Element.prototype.setAttribute;
  win.Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    nativeSetAttribute.call(this, name, URL_ATTRIBUTES.has(name.toLowerCase()) && typeof value === 'string' ? ownValue(name, value) : value);
  };

  for (const [ctor, props] of URL_PROPERTIES) {
    const proto = (win as unknown as Record<string, { prototype: object } | undefined>)[ctor]?.prototype;
    if (!proto) continue;
    for (const prop of props) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor?.set || !descriptor.configurable) continue;
      const nativeSet = descriptor.set;
      Object.defineProperty(proto, prop, {
        ...descriptor,
        set(this: unknown, value: unknown) {
          nativeSet.call(this, typeof value === 'string' ? ownValue(prop, value) : value);
        },
      });
    }
  }

  const fix = (el: Element) => {
    for (const attr of URL_ATTRIBUTES) {
      const current = el.getAttribute(attr);
      if (current === null) continue;
      const next = ownValue(attr, current);
      if (next !== current) nativeSetAttribute.call(el, attr, next);
    }
  };
  const selector = '[src],[href],[poster],[data],[action]';
  const observer = new win.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof win.Element) {
        fix(record.target);
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (!(node instanceof win.Element)) return;
        fix(node);
        node.querySelectorAll(selector).forEach(fix);
      });
    }
  });
  observer.observe(win.document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...URL_ATTRIBUTES],
  });
}

installBasePath();
