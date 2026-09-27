// Search-hit highlighting. Splits text into plain and matched segments so the UI
// can wrap the matches in <mark> without ever rendering HTML.
//
// Two sources of matches are merged:
//  - the server highlighter's `<mark>…</mark>` spans (Lucene knows about the
//    analyser's matches, e.g. case/diacritic folding), and
//  - every case-insensitive occurrence of each query term, so the title and the
//    offline fallback (which have no server marks) highlight too.

export interface HighlightPart {
  text: string;
  match: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Query → distinct terms, longest first so "banking" wins over "bank". */
export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^["'(]+|["')*]+$/g, ''))
    .filter((t) => t.length > 0);
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

export function highlightParts(source: string, query: string): HighlightPart[] {
  // Strip tags, remembering where the server's <mark> spans fell in the plain text.
  const ranges: Array<[number, number]> = [];
  let text = '';
  let markStart = -1;
  for (const piece of source.split(/(<\/?[^>]+>)/g)) {
    if (piece.startsWith('<') && piece.endsWith('>')) {
      if (/^<mark\b/i.test(piece)) markStart = text.length;
      else if (/^<\/mark>$/i.test(piece) && markStart >= 0) {
        ranges.push([markStart, text.length]);
        markStart = -1;
      }
      continue;
    }
    text += piece;
  }

  const terms = queryTerms(query);
  if (terms.length > 0) {
    const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length === 0) return text ? [{ text, match: false }] : [];

  // Merge overlapping/adjacent ranges, then slice.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else if (e > s) merged.push([s, e]);
  }
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) parts.push({ text: text.slice(at, s), match: false });
    parts.push({ text: text.slice(s, e), match: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
