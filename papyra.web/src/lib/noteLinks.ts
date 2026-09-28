import { useQuery } from '@tanstack/react-query';

// Web links in a note body — `[text](https://…)` and bare https URLs — for the
// Keep-style link cards. Images and embeds are attachments, not links, and
// code is left alone.

const MD_LINK = /(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
const BARE = /(?<![(<"'=])\bhttps?:\/\/[^\s<>()[\]"'`]+/g;

export function extractLinks(body: string, max = 3): string[] {
  if (!body || !body.includes('http')) return [];
  const text = body
    .replace(/(^|\n)\s{0,3}(```|~~~)[\s\S]*?\n\s{0,3}\2[^\n]*/g, '\n') // fenced code
    .replace(/`[^`\n]*`/g, ' ')                                        // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                              // images
  const found: string[] = [];
  const add = (raw: string) => {
    const url = raw.replace(/[.,;:!?)'"]+$/, '');
    if (!found.includes(url)) found.push(url);
  };
  for (const m of text.matchAll(MD_LINK)) add(m[1]);
  for (const m of text.replace(MD_LINK, ' ').matchAll(BARE)) add(m[0]);
  return found.slice(0, max);
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string | null;
  image: string | null;
  siteName: string;
  icon: string | null;
}

/** The server-fetched preview for one URL (cached a day there, an hour here). Null when the page has nothing to show. */
export function useLinkPreview(url: string | null) {
  return useQuery<LinkPreview | null>({
    queryKey: ['link-preview', url],
    enabled: !!url,
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url!)}`);
      if (res.status === 204 || !res.ok) return null;
      return res.json();
    },
  });
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
