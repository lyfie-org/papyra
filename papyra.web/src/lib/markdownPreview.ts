import { stripBlockAnchors } from './plainText';

// A note body parsed into the handful of block shapes a card preview draws.
// Deliberately a subset: enough that a card reads like the open note (lists and
// their nesting, headings, tasks, quotes, code, emphasis), cheap enough to run
// for every card on a 200-note desk, and never HTML — every node becomes a React
// element, so nothing in a note can inject markup into the grid.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del' | 'mark'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; c: Inline[] } // rendered as styled text: the whole card is a link
  | { t: 'embed'; v: string };

export interface ListItem {
  task: null | boolean; // null = plain item, else checked?
  content: Inline[];
  children: ListBlock | null;
}

export interface ListBlock {
  t: 'list';
  ordered: boolean;
  start: number;
  depth: number;
  items: ListItem[];
}

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'code'; v: string }
  | { t: 'hr' }
  | { t: 'embed'; v: string }
  | ListBlock;

// ── Inline ───────────────────────────────────────────────────────────────────

// Earliest-match scanner over the inline syntaxes a note uses. Order matters only
// for ties at the same index (`**` before `*`).
const INLINE: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
  { re: /`([^`]+)`/, make: (m) => ({ t: 'code', v: m[1] }) },
  { re: /!\[\[([^\]]+)\]\]/, make: (m) => ({ t: 'embed', v: m[1].split('|')[0].split('#')[0] }) },
  { re: /!\[([^\]]*)\]\([^)]*\)/, make: (m) => ({ t: 'embed', v: m[1] || 'image' }) },
  { re: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/, make: (m) => ({ t: 'link', c: [{ t: 'text', v: m[2] ?? m[1] }] }) },
  { re: /\[([^\]]+)\]\(([^)]*)\)/, make: (m) => ({ t: 'link', c: parseInline(m[1]) }) },
  { re: /\*\*(.+?)\*\*|__(.+?)__/, make: (m) => ({ t: 'strong', c: parseInline(m[1] ?? m[2]) }) },
  { re: /~~(.+?)~~/, make: (m) => ({ t: 'del', c: parseInline(m[1]) }) },
  { re: /==(.+?)==/, make: (m) => ({ t: 'mark', c: parseInline(m[1]) }) },
  { re: /(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/, make: (m) => ({ t: 'em', c: parseInline(m[1] ?? m[2]) }) },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    let best: { i: number; m: RegExpExecArray; make: (m: RegExpExecArray) => Inline } | null = null;
    for (const { re, make } of INLINE) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.i)) best = { i: m.index, m, make };
    }
    if (!best) { out.push({ t: 'text', v: rest }); break; }
    if (best.i > 0) out.push({ t: 'text', v: rest.slice(0, best.i) });
    out.push(best.make(best.m));
    rest = rest.slice(best.i + best.m[0].length);
  }
  return out;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

// A marker may end the line: luthor writes an empty item as `3. `, and an editor
// or git hook that trims trailing whitespace leaves `3.`. Both are an (empty)
// item — as CommonMark and the editor read them — never a paragraph saying "3.".
const LIST = /^(\s*)([-*+]|\d+[.)])(?:\s+|$)(?:\[([ xX])\](?:\s+|$))?(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*))?$/;
const HR = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const EMBED_LINE = /^\s*!\[\[([^\]]+)\]\]\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}/;

/** Width of leading whitespace, tabs counted as 4 (luthor nests lists by 4). */
function indentOf(s: string): number {
  let n = 0;
  for (const ch of s) n += ch === '\t' ? 4 : 1;
  return n;
}

/**
 * Parse a note body into preview blocks. Stops once `maxLines` source lines have
 * produced output, so a card never pays for the parts of a long note it would
 * clip anyway. Returns whether it stopped early (the card fades its bottom edge).
 */
export function parseBlocks(md: string, maxLines = 14): { blocks: Block[]; truncated: boolean } {
  const lines = stripBlockAnchors(md).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let used = 0;
  let i = 0;
  const full = () => used >= maxLines;

  while (i < lines.length && !full()) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence) && !full()) { body.push(lines[i]); i++; used++; }
      i++; // closing fence
      blocks.push({ t: 'code', v: body.join('\n') });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2] ?? '') }); i++; used++; continue; }
    if (HR.test(line) && !LIST.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    const e = EMBED_LINE.exec(line);
    if (e) { blocks.push({ t: 'embed', v: e[1].split('|')[0].split('#')[0] }); i++; used++; continue; }

    if (QUOTE.test(line)) {
      const q: Inline[][] = [];
      while (i < lines.length && QUOTE.test(lines[i]) && !full()) {
        const text = QUOTE.exec(lines[i])![1].replace(/^\[!\w+\]\s*/, ''); // callout marker
        if (text.trim()) { q.push(parseInline(text)); used++; }
        i++;
      }
      blocks.push({ t: 'quote', lines: q });
      continue;
    }

    if (LIST.test(line)) {
      // Collect the contiguous list (blank lines inside a loose list included),
      // then fold indentation into a tree.
      const rows: { indent: number; ordered: boolean; num: number; task: null | boolean; text: string }[] = [];
      while (i < lines.length && !full()) {
        const m = LIST.exec(lines[i]);
        if (m) {
          rows.push({
            indent: indentOf(m[1]),
            ordered: /\d/.test(m[2]),
            num: parseInt(m[2], 10) || 1,
            task: m[3] === undefined ? null : m[3].toLowerCase() === 'x',
            text: m[4],
          });
          used++; i++;
          continue;
        }
        if (!lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1])) { i++; continue; }
        break;
      }
      blocks.push(...buildLists(rows));
      continue;
    }

    // Table: rows without the pipes, rule line dropped.
    if (line.trim().startsWith('|')) {
      const rows: Inline[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && !full()) {
        if (!TABLE_RULE.test(lines[i])) {
          const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean);
          rows.push(parseInline(cells.join('  ·  ')));
          used++;
        }
        i++;
      }
      blocks.push({ t: 'p', lines: rows });
      continue;
    }

    // Paragraph: consecutive plain lines, each kept as its own line (the editor
    // shows a single newline as a line break).
    const para: Inline[][] = [];
    while (
      i < lines.length && lines[i].trim() && !full()
      && !LIST.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i])
      && !FENCE.test(lines[i]) && !EMBED_LINE.test(lines[i])
    ) {
      para.push(parseInline(lines[i].trim()));
      used++; i++;
    }
    blocks.push({ t: 'p', lines: para });
  }

  const truncated = lines.slice(i).some((l) => l.trim());
  return { blocks, truncated };
}

type Row = { indent: number; ordered: boolean; num: number; task: null | boolean; text: string };

/** Fold flat, indented list rows into nested lists. */
function buildLists(rows: Row[]): ListBlock[] {
  const top: ListBlock[] = [];
  // Open lists, innermost last, each with the indent its items sit at.
  const stack: { list: ListBlock; indent: number }[] = [];
  const open = (ordered: boolean, start: number, depth: number, indent: number) => {
    const list: ListBlock = { t: 'list', ordered, start, depth, items: [] };
    stack.push({ list, indent });
    return list;
  };

  for (const r of rows) {
    while (stack.length && r.indent < stack[stack.length - 1].indent) stack.pop();
    const cur = stack[stack.length - 1];

    if (!cur) {
      top.push(open(r.ordered, r.num, 0, r.indent));
    } else if (r.indent > cur.indent) {
      // Deeper: a child list hanging off the last item.
      const parent = cur.list.items[cur.list.items.length - 1];
      parent.children = open(r.ordered, r.num, cur.list.depth + 1, r.indent);
    } else if (stack.length === 1 && cur.list.ordered !== r.ordered) {
      // Bullets ⇄ numbers at the top level start a separate list, as the editor does.
      stack.pop();
      top.push(open(r.ordered, r.num, 0, r.indent));
    }

    stack[stack.length - 1].list.items.push({ task: r.task, content: parseInline(r.text), children: null });
  }
  return top;
}
