/*
 * Papyra service worker — the half of offline support that lives outside React.
 *
 * It does two jobs: keep the app shell loadable with no network (so a reload on
 * a train still boots Papyra rather than the browser's dinosaur), and keep the
 * last good answer for a small allowlist of read-only API calls, so the vault
 * renders from cache while the outbox holds the user's edits.
 *
 * Writes are never cached or replayed here — that is the app's outbox, which is
 * durable and conflict-aware. This file only ever touches GETs.
 */

const VERSION = 'papyra-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const FONT_CACHE = `${VERSION}-fonts`;

// Read-only endpoints worth keeping a copy of. `/api/auth/me` is the important
// one: without it the auth guard would bounce an offline user to /login.
const CACHEABLE_API = [
  '/api/auth/me',
  '/api/notes',
  '/api/notes/order',
  '/api/inbox',
  '/api/categories',
  '/api/settings',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app asks for a wipe on logout so a shared machine can't read the previous
// session's notes out of the cache.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'papyra-clear-data') {
    event.waitUntil(caches.delete(DATA_CACHE));
  }
});

function isCacheableApi(url) {
  return url.origin === self.location.origin && CACHEABLE_API.includes(url.pathname);
}

function isFont(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

// Hashed build output — immutable, so cache-first is safe and instant.
function isImmutableAsset(url) {
  return url.origin === self.location.origin && /^\/assets\//.test(url.pathname);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached) throw err;
    // Tag the replay. Without this the app can't tell a real 200 from a cached
    // one, and would report itself online while the API is unreachable.
    const headers = new Headers(cached.headers);
    headers.set('X-Papyra-Cache', 'hit');
    return new Response(await cached.blob(), { status: 200, statusText: 'OK (cached)', headers });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Opaque font responses are fine to keep — they're only ever replayed as-is.
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes belong to the outbox, not here

  const url = new URL(request.url);

  // SPA navigations: try the network so a new deploy lands, fall back to the
  // cached shell (MapFallbackToFile serves index.html for every route).
  if (request.mode === 'navigate') {
    event.respondWith(
      // `no-store` so the shell is always revalidated against the server: a
      // deploy has to reach an open tab, and an HTTP-cached index.html would
      // keep pinning it to the previous asset hashes.
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.open(SHELL_CACHE).then((cache) => cache.match('/'))),
    );
    return;
  }

  if (isImmutableAsset(url)) { event.respondWith(cacheFirst(request, SHELL_CACHE)); return; }
  if (isFont(url)) { event.respondWith(cacheFirst(request, FONT_CACHE)); return; }
  if (isCacheableApi(url)) { event.respondWith(networkFirst(request, DATA_CACHE)); return; }
});
