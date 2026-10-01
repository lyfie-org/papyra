// Which attachments a note body points at — the web twin of the API's
// MediaRefParser. Both sides run the same fixture
// (papyra.api/tests/fixtures/media-refs.json), so the card grid, the editor
// and the server's share scoping/vault gate/pruning agree on what a note embeds.
//
// Covered: `![[photo.png]]`, `![[photo.png|480]]`, `![[doc.pdf#page=3]]`,
// `[[doc.pdf]]`, `![alt](/api/media/photo.png)`, relative `![](attachments/x.png)`,
// `<url>` forms, HTML `src=`/`href=`/`poster=` and bare `/api/media/…` URLs.
// Names compare case-insensitively (Obsidian's do) and are reduced to their last
// path segment (imports flatten folders into the media dir).

const MARKDOWN_LINK = /\]\(\s*(<[^>\r\n]+>|[^)\s]+)/g;
const HTML_ATTR = /\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const API_MEDIA_URL = /\/api\/(?:media|shared\/[^/\s]+\/media|shares\/incoming\/\d+\/media)\/([^\s)"'<>\]|#?]+)/g;
const SCHEME = /^[A-Za-z0-9+.-]+:/;

/**
 * The target inside `![[…]]`: what comes before the first `|`, `#` or `^`
 * (size/alt, page fragment and block ref are not part of the name). An escaped
 * pipe (`\|`, written inside tables) ends the name too.
 */
export function embedTarget(inner: string): string {
  const cut = inner.search(/\\?\||[#^]/);
  return (cut >= 0 ? inner.slice(0, cut) : inner).trim();
}

/** `youtube:` / `iframe:` / `card:` embeds carry URLs, not attachments. */
export function isUrlEmbed(target: string): boolean {
  return target.includes(':');
}

function unescape(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * The attachment a link or image URL points at, or null for a web address or
 * an app route: `/api/media/x.png` (any share prefix) → `x.png`; a relative
 * `attachments/x.png` → `attachments/x.png` (callers keep the last segment).
 */
export function attachmentFromUrl(url: string): string | null {
  if (!url) return null;
  const api = new RegExp(API_MEDIA_URL.source).exec(url);
  if (api) return unescape(api[1]);
  // A web address, protocol-relative/rooted path or pure fragment is never a
  // vault attachment.
  if (url.startsWith('/') || url.startsWith('#') || url.includes('://') || SCHEME.test(url)) return null;
  const cut = url.search(/[?#]/);
  const name = unescape(cut >= 0 ? url.slice(0, cut) : url);
  return name || null;
}

/**
 * The inside of every `[[…]]` (an embed's `!` is optional): exactly what
 * `/!?\[\[([^\]\r\n]+)\]\]/g` matches, in one pass. As that regex, a run of
 * `[[` with no closing `]]` (a pasted log, a hostile note) was rescanned from
 * every opening to the end of the run — quadratic. Every opening inside one
 * run stops at the same `]` or line break, so a failed run is skipped whole.
 */
function* wikiTargets(body: string): Generator<string> {
  let at = body.indexOf('[[');
  while (at >= 0) {
    const start = at + 2;
    let stop = start;
    while (stop < body.length) {
      const c = body.charCodeAt(stop);
      if (c === 93 /* ] */ || c === 13 || c === 10) break;
      stop++;
    }
    const closed = stop > start && body.charCodeAt(stop) === 93 && body.charCodeAt(stop + 1) === 93;
    if (closed) yield body.slice(start, stop);
    at = body.indexOf('[[', closed ? stop + 2 : Math.max(stop, at + 1));
  }
}

/**
 * Every attachment name the body references, first spelling kept, unique
 * case-insensitively, in order of appearance.
 */
export function extractMediaRefs(body: string | null | undefined): string[] {
  const names = new Map<string, string>();
  if (!body) return [];

  const add = (raw: string) => {
    let target = raw.trim().replace(/\\/g, '/');
    const slash = target.lastIndexOf('/');
    if (slash >= 0) target = target.slice(slash + 1);
    if (target.length === 0 || target.length > 255 || target === '.' || target === '..') return;
    const key = target.toLowerCase();
    if (!names.has(key)) names.set(key, target);
  };

  const addUrl = (url: string) => {
    const name = attachmentFromUrl(url);
    if (name) add(name);
  };

  for (const inner of wikiTargets(body)) {
    const target = embedTarget(inner);
    if (!isUrlEmbed(target)) add(target);
  }
  for (const m of body.matchAll(MARKDOWN_LINK)) addUrl(m[1].replace(/^<|>$/g, ''));
  for (const m of body.matchAll(HTML_ATTR)) addUrl(m[1] ?? m[2] ?? '');
  for (const m of body.matchAll(API_MEDIA_URL)) add(unescape(m[1]));
  return [...names.values()];
}
