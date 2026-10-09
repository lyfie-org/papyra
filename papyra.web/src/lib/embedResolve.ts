import { toEmbeddableUrl } from '@lyfie/luthor-headless';
import type { PapyraEmbedResolution } from '@lyfie/luthor/presets/papyra';
import type { SavedCardMetadata } from '@lyfie/luthor-headless';

// "Embed a link" works with whatever link someone has. The editor maps the
// well-known services itself (maps, videos, songs, documents — luthor's
// toEmbeddableUrl); anything else is asked about here, on the server
// (`/api/embed/resolve`, SSRF-guarded): where a short link lands, whether the
// site will be shown in a frame at all, and its oEmbed player if it has one.
// A site that refuses framing becomes a link card instead of a frame that
// says "refused to connect".

/** The server's answer (EmbedResolution, camelCased). */
export interface ServerEmbedResolution {
  url: string;
  finalUrl: string;
  frameable: boolean;
  embedSrc?: string | null;
  width?: number | null;
  height?: number | null;
  title?: string | null;
}

/**
 * A short link can land on a consent page first (Google's, for a server in the
 * EU) that carries the real destination in `continue`.
 */
export function unwrapInterstitial(url: string): string {
  try {
    const u = new URL(url);
    if (/^consent\.(google|youtube)\./i.test(u.hostname)) return u.searchParams.get('continue') ?? url;
  } catch {
    /* not a URL: leave it */
  }
  return url;
}

/** Turn the server's findings into what the editor should place. */
export function toEmbedResolution(data: ServerEmbedResolution): PapyraEmbedResolution {
  const title = data.title ?? undefined;
  // A short link that landed somewhere well-known (maps.app.goo.gl → Google Maps).
  const known = toEmbeddableUrl(unwrapInterstitial(data.finalUrl));
  if (known) return { type: 'iframe', src: known.src, title: known.title ?? title, width: known.width, height: known.height };
  if (data.embedSrc) {
    return { type: 'iframe', src: data.embedSrc, title, width: data.width ?? undefined, height: data.height ?? undefined };
  }
  if (data.frameable) return { type: 'iframe', src: data.finalUrl, title };
  return { type: 'card', url: data.url, title };
}

export async function resolveEmbed(url: string, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<PapyraEmbedResolution | null> {
  try {
    const res = await fetcher(`/api/embed/resolve?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
    if (!res.ok || res.status === 204) return null;
    return toEmbedResolution(await res.json() as ServerEmbedResolution);
  } catch {
    return null; // offline: the link stays framed as given
  }
}

/** A saved link card's title, summary and picture (the server's link preview). */
export async function resolveCard(url: string, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<SavedCardMetadata | null> {
  try {
    const res = await fetcher(`/api/link-preview?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
    if (!res.ok || res.status === 204) return null;
    const p = await res.json() as { title?: string; description?: string | null; image?: string | null; siteName?: string; icon?: string | null };
    return {
      title: p.title,
      description: p.description ?? undefined,
      image: p.image ?? undefined,
      favicon: p.icon ?? undefined,
      siteName: p.siteName,
    };
  } catch {
    return null;
  }
}
