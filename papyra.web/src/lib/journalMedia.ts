import { extractMediaRefs } from './mediaRefs';

const IMAGE = /\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i;

/** The pictures a day's text shows, in the order they appear, each once. */
export function dayImages(markdown: string | null | undefined): string[] {
  return extractMediaRefs(markdown).filter((name) => IMAGE.test(name));
}

/** What `markdown` references that `before` did not: the file a just-finished upload became. */
export function newRefs(before: readonly string[], markdown: string | null | undefined): string[] {
  const had = new Set(before.map((n) => n.toLowerCase()));
  return extractMediaRefs(markdown).filter((n) => !had.has(n.toLowerCase()));
}

/** A small, cached picture for the strip: the server resizes, the original is never fetched. */
export function stripThumb(name: string, width = 160): string {
  return `/api/media/${encodeURIComponent(name)}/thumb?w=${width}`;
}
