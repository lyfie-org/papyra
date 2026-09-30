import type { MediaMeta, MediaUrlOptions } from '@lyfie/luthor-headless';

// Attachment metadata (kind, size, intrinsic width/height, content version,
// whether a thumbnail/poster exists) for embeds and cards, so a picture's box
// is reserved before a byte of it loads and grids ask for thumbnails, never
// originals.
//
// Lookups are synchronous reads of a cache (the editor reads them through
// useSyncExternalStore); a miss queues the name, and every miss in the same
// ~30ms is fetched in one `POST {base}/meta`. One store per media base, shared
// by every editor and card on the page:
//   /api/media                       — the owner's own files
//   /api/shared/{token}/media        — a public link (scoped to that note)
//   /api/shares/incoming/{id}/media  — a signed-in grantee's share

const BATCH_DELAY_MS = 30;
const BATCH_MAX = 200; // the server's cap per request
const MAX_ENTRIES = 4000;
// A file with no metadata (missing, not yours, locked in the vault, or the
// lookup failed) is asked about again after this — unlocking the vault makes
// it readable. Until then it renders from its original, like before metadata.
const NULL_TTL_MS = 30_000;

export interface MediaMetaStore {
  /** Cached metadata: `undefined` while unknown (a lookup is queued), `null` when there is none. Same object until it changes. */
  get(name: string): MediaMeta | null | undefined;
  /** Called whenever any lookup lands. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Record metadata already in hand (an upload's response) — no request. */
  prime(name: string, meta: MediaMeta | null): void;
}

interface Entry { meta: MediaMeta | null; at: number }

type Fetcher = typeof fetch;

/** The server's JSON (camelCase, nulls) → the editor's MediaMeta. */
export function toMediaMeta(raw: unknown): MediaMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    kind: str(r.kind),
    mime: str(r.mime),
    size: num(r.size),
    version: str(r.version),
    width: num(r.width) ?? null,
    height: num(r.height) ?? null,
    durationMs: num(r.durationMs) ?? null,
    animated: r.animated === true,
    poster: r.poster === true,
    thumb: r.thumb === true,
  };
}

export function createMediaMetaStore(base: string, fetcher: Fetcher = (...a) => fetch(...a)): MediaMetaStore {
  const cache = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => { for (const l of [...listeners]) l(); };

  const store = (name: string, meta: MediaMeta | null) => {
    cache.delete(name); // re-insert: Map order doubles as recency
    cache.set(name, { meta, at: Date.now() });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };

  const flush = async () => {
    timer = undefined;
    const names = [...queued];
    queued.clear();
    for (let i = 0; i < names.length; i += BATCH_MAX) {
      const chunk = names.slice(i, i + BATCH_MAX);
      chunk.forEach((n) => inFlight.add(n));
      try {
        const res = await fetcher(`${base}/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: chunk }),
          credentials: 'same-origin',
        });
        const data = res.ok ? (await res.json()) as Record<string, unknown> | null : null;
        for (const n of chunk) store(n, toMediaMeta(data?.[n]));
      } catch {
        for (const n of chunk) store(n, null); // offline: originals, asked again later
      } finally {
        chunk.forEach((n) => inFlight.delete(n));
      }
    }
    emit();
  };

  const request = (name: string) => {
    if (queued.has(name) || inFlight.has(name)) return;
    queued.add(name);
    timer ??= setTimeout(() => { void flush(); }, BATCH_DELAY_MS);
  };

  return {
    get(name) {
      if (!name) return null;
      const hit = cache.get(name);
      if (hit) {
        if (hit.meta === null && Date.now() - hit.at > NULL_TTL_MS) request(name);
        return hit.meta;
      }
      request(name);
      return undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prime(name, meta) {
      store(name, meta);
      emit();
    },
  };
}

const stores = new Map<string, MediaMetaStore>();

/** The page-wide store for one media base. */
export function mediaMetaStore(base: string): MediaMetaStore {
  let s = stores.get(base);
  if (!s) {
    s = createMediaMetaStore(base);
    stores.set(base, s);
  }
  return s;
}

const THUMB_WIDTHS = [160, 320, 640, 1280];

/** The server's thumbnail buckets: the smallest at least `w` wide. */
export function snapThumbWidth(w: number | undefined): number {
  const want = w ?? 320;
  return THUMB_WIDTHS.find((b) => want <= b) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
}

/**
 * A URL for one rendition of an attachment under `base`. Thumbnails and posters
 * carry the content version when it is known, which the server answers with a
 * year-long immutable cache (a replaced file gets a new name, never new bytes).
 */
export function mediaUrl(
  base: string, name: string, options?: MediaUrlOptions, meta?: MediaMeta | null,
): string {
  const path = `${base}/${encodeURIComponent(name)}`;
  const variant = options?.variant ?? 'original';
  if (variant === 'original') return path;
  const v = meta?.version ? `&v=${encodeURIComponent(meta.version)}` : '';
  return `${path}/thumb?w=${snapThumbWidth(options?.width)}${v}`;
}
