import {
  $getSelection,
  $isLineBreakNode,
  $isTextNode,
  $setSelection,
  HISTORY_MERGE_TAG,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  type LexicalEditor,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';

// Bold, italic, strikethrough, highlight and underline are written to the .md
// file as delimiters (`**`, `*`, `~~`, `==`, `++`), and a delimiter only counts
// when it "flanks" its text the way CommonMark says. Lexical's importer applies
// that rule; its exporter does not. So formatting that ends on punctuation
// right before a letter — `<b>Mix:</b>60g`, which AI chat answers paste all
// the time — was saved as `**Mix:**60g`, and on the next open the body showed
// the literal asterisks (while the card's looser preview still showed bold).
// One edit after that, Lexical escaped them (`\*\*`) for good.
//
// Two halves, both mirroring Lexical's importer exactly (ASCII punctuation;
// only space, tab and line breaks count as whitespace — not NBSP):
// - registerMarkdownSafeFormats keeps the document itself representable, so
//   what is saved is what is shown and reopens the same.
// - repairEmphasis reads files already written that way as the bold they meant.

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/;
const WHITESPACE = /[ \t\n\r\f]/;

type Kind = 'space' | 'punct' | 'word';

/** How Lexical's flanking rule sees a character; `undefined` is the line's edge. */
function kindOf(ch: string | undefined): Kind {
  if (ch === undefined || WHITESPACE.test(ch)) return 'space';
  return PUNCTUATION.test(ch) ? 'punct' : 'word';
}

/** Can a delimiter between `before` and `first` open a span? (left-flanking) */
function canOpen(before: Kind, first: Kind): boolean {
  return first !== 'space' && (first === 'word' || before !== 'word');
}

/** Can a delimiter between `last` and `after` close a span? (right-flanking) */
function canClose(last: Kind, after: Kind): boolean {
  return last !== 'space' && (last === 'word' || after !== 'word');
}

// ── Writer: keep format boundaries representable ───────────────────────────

const DELIMITED: readonly TextFormatType[] = ['bold', 'italic', 'strikethrough', 'highlight', 'underline'];

/** The neighbour's character at the boundary, as the exported markdown will have it. */
function edgeKind(node: LexicalNode | null, side: 'first' | 'last'): Kind | null {
  if (node === null || $isLineBreakNode(node)) return 'space';
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    if (!text) return null; // an empty node says nothing; leave it to normalisation
    // Inline code exports inside backticks — punctuation either way.
    if (node.hasFormat('code')) return 'punct';
    return kindOf(side === 'first' ? text[0] : text[text.length - 1]);
  }
  // A link writes `[` first and `)` last; other inline nodes (mentions, wikilinks,
  // embeds) are treated as a word — at worst a harmless extra split.
  const type = node.getType();
  if (type === 'link' || type === 'autolink') return 'punct';
  return 'word';
}

/** The run of `kind` characters at one end of `text` (length). */
function edgeRun(text: string, kind: Kind, side: 'first' | 'last'): number {
  let n = 0;
  if (side === 'last') {
    for (let i = text.length - 1; i >= 0 && kindOf(text[i]) === kind; i--) n++;
  } else {
    for (let i = 0; i < text.length && kindOf(text[i]) === kind; i++) n++;
  }
  return n;
}

function clearFormats(node: TextNode, formats: readonly TextFormatType[]) {
  for (const f of formats) if (node.hasFormat(f)) node.toggleFormat(f);
}

/**
 * Splits off the characters at one end of a text node that a delimiter cannot
 * sit next to, and takes the formats that would need that delimiter off them.
 * One punctuation mark is enough (the delimiter then sits between two marks,
 * which is allowed): `(Thu):` keeps its `)`. Spaces go as a run.
 * Returns true when the document changed.
 */
function fixEdge(node: TextNode, side: 'first' | 'last', formats: readonly TextFormatType[], kind: Kind): boolean {
  const text = node.getTextContent();
  const run = kind === 'punct' ? Math.min(1, edgeRun(text, kind, side)) : edgeRun(text, kind, side);
  if (run === 0) return false;
  if (run === text.length) {
    clearFormats(node, formats);
    return true;
  }
  const parts = side === 'last' ? node.splitText(text.length - run) : node.splitText(run);
  clearFormats(side === 'last' ? parts[1] : parts[0], formats);
  return true;
}

function guardTextNode(node: TextNode) {
  if (!node.isSimpleText() || node.hasFormat('code')) return;
  const text = node.getTextContent();
  if (!text) return;
  const own = DELIMITED.filter((f) => node.hasFormat(f));
  if (own.length === 0) return;

  // Formats that end here (closing delimiter after this node). Only a boundary
  // with real text on the other side is touched: the end of a paragraph is
  // where people are typing, and splitting there would drop the format from
  // the next keystroke.
  const next = node.getNextSibling();
  if ($isTextNode(next) && next.getTextContent()) {
    const closing = own.filter((f) => !next.hasFormat(f));
    const after = edgeKind(next, 'first');
    if (closing.length > 0 && after !== null) {
      const last = kindOf(text[text.length - 1]);
      if (!canClose(last, after)) {
        if (fixEdge(node, 'last', closing, last)) return;
      }
    }
  }

  const prev = node.getPreviousSibling();
  if ($isTextNode(prev) && prev.getTextContent()) {
    const opening = own.filter((f) => !prev.hasFormat(f));
    const before = edgeKind(prev, 'last');
    if (opening.length > 0 && before !== null) {
      const first = kindOf(text[0]);
      if (!canOpen(before, first)) fixEdge(node, 'first', opening, first);
    }
  }
}

/**
 * Keeps every bold/italic/strike/highlight/underline boundary in a form the
 * markdown file can hold: punctuation or a space on the inside edge of a run,
 * against a letter on the outside, moves out of the run. `<b>Mix:</b>60g`
 * becomes **Mix**:60g — visually the same, and it reopens as bold.
 */
export function registerMarkdownSafeFormats(editor: LexicalEditor): () => void {
  return editor.registerNodeTransform(TextNode, guardTextNode);
}

// ── Reader: repair what was already saved ──────────────────────────────────

// Longest first, so `***` is never read as `**` + `*`.
const DELIMITERS = ['***', '**', '~~', '==', '++', '*'] as const;

const escapeRe = (s: string) => s.replace(/[*+=~]/g, '\\$&');

function spanPattern(delim: string): RegExp {
  const c = escapeRe(delim[0]);
  const d = escapeRe(delim);
  // An unescaped run of exactly this delimiter, text without the delimiter
  // character, and the same run again.
  return new RegExp(`(?<![\\\\${c}])${d}(?!${c})([^${c}\\n]+?)(?<![\\\\${c}])${d}(?!${c})`, 'g');
}

const SPANS = DELIMITERS.map((d) => ({ delim: d, re: spanPattern(d) }));

/** `[start, end)` ranges of inline code on a line — never rewritten. */
function codeRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  // A span of N backticks closes at the next run of exactly N.
  const re = /(`+)(?!`).*?(?<!`)\1(?!`)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length]);
  return out;
}

function repairLine(line: string): string {
  if (!/[*~=+]/.test(line)) return line;
  let out = line;
  for (const { delim, re } of SPANS) {
    const code = codeRanges(out);
    out = out.replace(re, (whole, content: string, at: number, src: string) => {
      if (code.some(([s, e]) => at < e && at + whole.length > s)) return whole;
      if (WHITESPACE.test(content[0]) || WHITESPACE.test(content[content.length - 1])) return whole;
      const before = kindOf(src[at - 1]);
      const after = kindOf(src[at + whole.length]);
      const opens = canOpen(before, kindOf(content[0]));
      const closes = canClose(kindOf(content[content.length - 1]), after);
      if (opens && closes) return whole;
      // A single `*` between letters is as likely a literal (`a*(b)*c`): only
      // repair it at a word boundary, the shape Lexical's writer produces.
      if (delim === '*' && !opens && !closes) return whole;
      if (delim === '*' && ((!closes && before === 'word') || (!opens && after === 'word'))) return whole;

      let lead = '';
      let body = content;
      let trail = '';
      // One mark out is enough, as in fixEdge.
      if (!closes) {
        if (kindOf(body[body.length - 1]) !== 'punct') return whole;
        trail = body[body.length - 1];
        body = body.slice(0, -1);
      }
      if (!opens) {
        if (!body || kindOf(body[0]) !== 'punct') return whole;
        lead = body[0];
        body = body.slice(1);
      }
      if (!body) return lead + trail;
      const fixed = canOpen(lead ? kindOf(lead[lead.length - 1]) : before, kindOf(body[0]))
        && canClose(kindOf(body[body.length - 1]), trail ? kindOf(trail[0]) : after);
      return fixed ? `${lead}${delim}${body}${delim}${trail}` : whole;
    });
  }
  return out;
}

/**
 * Rewrites formatting spans that Lexical's own writer produced but its reader
 * rejects (`**Mix:**60g` → `**Mix**:60g`), so notes saved before
 * registerMarkdownSafeFormats open as the formatting they were written with.
 * Fenced code and inline code are left alone. Pure; well-formed input comes
 * back unchanged.
 */
export function repairEmphasis(markdown: string): string {
  if (!/[*~=+]/.test(markdown)) return markdown;
  const lines = markdown.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) { fence = open[1]; continue; }
    lines[i] = repairLine(lines[i]);
  }
  return lines.join('\n');
}

// ── Focus: a background update must not pull the caret into the body ──────

/**
 * Lexical keeps its selection after the body loses focus, and any later update
 * — a transform registering, an image settling, a remote change — writes that
 * selection back to the DOM, which focuses the body. Typing in the title then
 * jumped to the end of the note mid-word. When focus moves to a field outside
 * the canvas, the editor lets go of its selection; clicking back into the body
 * sets a fresh one as usual.
 *
 * `scope` is the surface the editor lives in (the note sheet); `canvas` matches
 * the editor's own area inside it, whose controls (toolbar, menus) still act on
 * the selection.
 */
export function releaseSelectionOnLeave(editor: LexicalEditor, scope: HTMLElement, canvas: string): () => void {
  const releaseFor = (target: Element | null) => {
    if (!target || !scope.contains(target) || target.closest(canvas)) return;
    const root = editor.getRootElement();
    if (!root || root.contains(target)) return;
    if (editor.getEditorState().read(() => $getSelection()) === null) return;
    editor.update(() => { $setSelection(null); }, { tag: [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG], discrete: true });
  };
  const onFocusIn = (e: FocusEvent) => releaseFor(e.target as Element | null);
  // Already in a field (the editor mounted while the title had focus).
  releaseFor(document.activeElement);
  scope.addEventListener('focusin', onFocusIn);
  return () => scope.removeEventListener('focusin', onFocusIn);
}
