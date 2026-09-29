/**
 * Anchoring comments to a passage of the rendered note without touching the
 * note itself — the W3C Web Annotation "TextQuoteSelector" (what Hypothesis and
 * most annotation tools use): remember the exact text plus a little context on
 * each side, and find it again in whatever the editor renders now.
 *
 * The note's markdown and the live room's Yjs doc stay untouched, so there is
 * nothing for a concurrent edit to conflict with. If the passage is edited away
 * the quote simply stops matching and the thread is "detached" instead of
 * pointing at the wrong words.
 *
 * Both directions go through one flattened text model of the editor root, so a
 * quote taken from a selection is found again by exactly the same rules.
 */

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

interface Piece {
  node: Text;
  start: number;
}

export interface TextIndex {
  root: Element;
  text: string;
  pieces: Piece[];
}

const BLOCKS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DIV', 'UL', 'OL', 'TABLE', 'TR',
]);
const CONTEXT = 32;

function blockOf(node: Node, root: Element): Element | null {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCKS.has(el.tagName)) return el;
  }
  return root;
}

/** Flatten the root's text: text nodes in order, "\n" between blocks and at <br>. */
export function buildTextIndex(root: Element): TextIndex {
  const pieces: Piece[] = [];
  let text = '';
  let lastBlock: Element | null = null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE || (n as Element).tagName === 'BR'
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== Node.TEXT_NODE) { text += '\n'; continue; }
    const t = n as Text;
    if (!t.data) continue;
    const block = blockOf(t, root);
    if (lastBlock && block !== lastBlock && !text.endsWith('\n')) text += '\n';
    lastBlock = block;
    pieces.push({ node: t, start: text.length });
    text += t.data;
  }
  return { root, text, pieces };
}

/** A DOM boundary point → offset in the flattened text. */
function offsetOf(index: TextIndex, container: Node, offset: number): number | null {
  if (!index.root.contains(container)) return null;
  if (container.nodeType === Node.TEXT_NODE) {
    const piece = index.pieces.find(p => p.node === container);
    if (piece) return piece.start + Math.min(offset, piece.node.data.length);
  }
  // An element boundary sits before its offset-th child (or after its last).
  const child = container.childNodes[offset] ?? null;
  for (const p of index.pieces) {
    if (child) {
      if (child === p.node || child.contains(p.node)
        || (child.compareDocumentPosition(p.node) & Node.DOCUMENT_POSITION_FOLLOWING)) return p.start;
    } else if (!container.contains(p.node)
      && (container.compareDocumentPosition(p.node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      return p.start;
    }
  }
  return index.text.length;
}

/** The quote for a selection inside the root, or null if it is empty or outside. */
export function quoteFromRange(index: TextIndex, range: Range): TextQuote | null {
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  // Trim whitespace the selection dragged along at either end.
  let s = start;
  let e = end;
  while (s < e && /\s/.test(index.text[s])) s++;
  while (e > s && /\s/.test(index.text[e - 1])) e--;
  if (e <= s) return null;
  return {
    exact: index.text.slice(s, e),
    prefix: index.text.slice(Math.max(0, s - CONTEXT), s),
    suffix: index.text.slice(e, e + CONTEXT),
  };
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Where the quote best matches: every occurrence of `exact`, scored by context. */
export function findQuote(text: string, quote: TextQuote): { start: number; end: number } | null {
  if (!quote.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let at = text.indexOf(quote.exact); at >= 0; at = text.indexOf(quote.exact, at + 1)) {
    const before = text.slice(Math.max(0, at - quote.prefix.length), at);
    const after = text.slice(at + quote.exact.length, at + quote.exact.length + quote.suffix.length);
    const score = commonSuffix(before, quote.prefix) + commonPrefix(after, quote.suffix);
    if (!best || score > best.score) best = { start: at, score };
  }
  return best ? { start: best.start, end: best.start + quote.exact.length } : null;
}

function pointAt(index: TextIndex, offset: number, end: boolean): [Text, number] | null {
  for (const p of index.pieces) {
    const len = p.node.data.length;
    if (end ? offset <= p.start + len && offset > p.start : offset < p.start + len && offset >= p.start) {
      return [p.node, offset - p.start];
    }
  }
  return null;
}

/** A live DOM Range over the quote, or null when it no longer appears (detached). */
export function rangeForQuote(index: TextIndex, quote: TextQuote): Range | null {
  const hit = findQuote(index.text, quote);
  if (!hit) return null;
  const a = pointAt(index, hit.start, false);
  const b = pointAt(index, hit.end, true);
  if (!a || !b) return null;
  const range = index.root.ownerDocument.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  return range;
}
