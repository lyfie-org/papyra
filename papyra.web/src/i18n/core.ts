/**
 * The pure half of translations: finding a message, filling in its values, splitting
 * `<tag>markup</tag>`. No React, no browser, so every rule here is unit-tested directly.
 *
 * A catalog is a flat object of dotted keys to sentences:
 *
 *     "notes.count_one":   "{count} note"
 *     "notes.count_other": "{count} notes"
 *     "update.lede":       "Read the <link>release notes</link> before you update."
 *
 * - `{name}`   a value the caller passes in. Translators may move it, never rename it.
 * - `<tag>…</tag>` markup the caller turns into an element (a link, bold). Translators keep the tags.
 * - `_zero _one _two _few _many _other` after a key: plural forms, picked with `Intl.PluralRules`
 *   by the `count` value. Every plural key must have `_other`.
 */

export type Catalog = Readonly<Record<string, string>>;
export type Values = Readonly<Record<string, string | number>>;

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** The key a plural entry belongs to: `notes.count_one` → `notes.count`; any other key is its own base. */
export function baseKey(key: string): string {
  const cut = key.lastIndexOf('_');
  if (cut < 1) return key;
  return (PLURAL_CATEGORIES as readonly string[]).includes(key.slice(cut + 1)) ? key.slice(0, cut) : key;
}

const rulesCache = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, count: number): PluralCategory {
  let rules = rulesCache.get(locale);
  if (!rules) {
    try { rules = new Intl.PluralRules(locale); } catch { rules = new Intl.PluralRules('en'); }
    rulesCache.set(locale, rules);
  }
  return rules.select(count) as PluralCategory;
}

/**
 * The sentence for `key`, or null when this catalog has none. With a `count`, the plural form for
 * `locale` is tried first, then `_other`; without one, the key itself.
 */
export function pick(catalog: Catalog, key: string, locale: string, count?: number): string | null {
  if (count !== undefined) {
    const cat = pluralCategory(locale, count);
    // A language written without plural forms (the key is a plain sentence) still works.
    return catalog[`${key}_${cat}`] ?? catalog[`${key}_other`] ?? catalog[key] ?? null;
  }
  return catalog[key] ?? null;
}

/** Replace each `{name}` with its value. A name nobody passed stays visible rather than vanishing. */
export function fill(message: string, values?: Values): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The `{names}` in a message, in order of first appearance. */
export function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
}

/** The `<tags>` in a message, in order of first appearance. */
export function tags(message: string): string[] {
  return [...new Set([...message.matchAll(/<(\w+)>/g)].map(m => m[1]))];
}

export type Piece = string | { tag: string; children: Piece[] };

/**
 * Split a message into text and `<tag>…</tag>` runs (nesting allowed). A tag with no closing partner,
 * or a closing tag with no opener, is left as plain text so a typo in a translation shows up instead of crashing.
 */
export function parseRich(message: string): Piece[] {
  const root: Piece[] = [];
  const stack: { tag: string; children: Piece[] }[] = [];
  const out = () => (stack.length ? stack[stack.length - 1].children : root);
  const pushText = (text: string) => {
    if (!text) return;
    const list = out();
    const last = list[list.length - 1];
    if (typeof last === 'string') list[list.length - 1] = last + text;
    else list.push(text);
  };

  let at = 0;
  for (const m of message.matchAll(/<(\/?)(\w+)>/g)) {
    pushText(message.slice(at, m.index));
    at = m.index + m[0].length;
    const [whole, closing, tag] = m;
    if (!closing) {
      stack.push({ tag, children: [] });
    } else if (stack.length && stack[stack.length - 1].tag === tag) {
      const done = stack.pop()!;
      out().push(done);
    } else {
      pushText(whole);                       // closing tag with no opener
    }
  }
  pushText(message.slice(at));
  // Openers never closed: give their text back as plain text.
  while (stack.length) {
    const open = stack.pop()!;
    pushText(`<${open.tag}>`);
    for (const child of open.children) {
      if (typeof child === 'string') pushText(child); else out().push(child);
    }
  }
  return root;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb']);
/** Reading direction of a language code such as `ar` or `he-IL`. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  return RTL.has(locale.toLowerCase().split('-')[0]) ? 'rtl' : 'ltr';
}

/** The available language that best matches what the browser asked for, or null. Exact first, then same language. */
export function bestMatch(wanted: readonly string[], available: readonly string[]): string | null {
  const lower = new Map(available.map(a => [a.toLowerCase(), a]));
  // By preference: the first language asked for wins, whether as an exact match or a same-language one.
  for (const w of wanted) {
    const exact = lower.get(w.toLowerCase());
    if (exact) return exact;
    const lang = w.toLowerCase().split('-')[0];
    const near = available.find(a => a.toLowerCase().split('-')[0] === lang);
    if (near) return near;
  }
  return null;
}

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
};

/**
 * A made-up language for finding text that was never moved into the catalog: every letter gets an accent
 * and the sentence is padded by about a third, as translations often are. `{values}` and `<tags>` are untouched.
 * Whatever still reads as plain English on screen is not coming from a catalog.
 */
export function pseudo(message: string): string {
  const body = message
    .split(/(\{\w+\}|<\/?\w+>)/g)
    .map((part, i) => (i % 2 === 1 ? part : [...part].map(ch => {
      const low = ch.toLowerCase();
      const mapped = ACCENTS[low];
      return mapped ? (ch === low ? mapped : mapped.toUpperCase()) : ch;
    }).join('')))
    .join('');
  const pad = '·'.repeat(Math.ceil(message.replace(/\{\w+\}|<\/?\w+>/g, '').length / 3));
  return `⟦${body}${pad}⟧`;
}

/**
 * What is wrong with a translation file compared with the English one? Empty means it is sound.
 * A translation may leave keys out (they fall back to English) but may not invent keys, change the
 * `{values}` or `<tags>` a sentence uses, leave a sentence empty, or give a plural key no `_other`.
 */
export function compareCatalogs(source: Catalog, target: Catalog): string[] {
  const problems: string[] = [];
  const sourceBases = new Set(Object.keys(source).map(baseKey));
  for (const [key, text] of Object.entries(target)) {
    if (key === 'meta.name') { if (!text.trim()) problems.push('meta.name is empty'); continue; }
    if (!sourceBases.has(baseKey(key))) { problems.push(`${key}: no such message in English`); continue; }
    if (!text.trim()) { problems.push(`${key}: empty`); continue; }
    // Compare with the English sentence of the same plural form, else any form of that message.
    const english = source[key] ?? source[`${baseKey(key)}_other`] ?? source[`${baseKey(key)}_one`];
    if (english === undefined) continue;
    const isPlural = baseKey(key) !== key;
    const wantValues = new Set(placeholders(english));
    // A plural form may drop {count} ("One note"), but may not add or rename a value.
    for (const name of placeholders(text)) {
      if (!wantValues.has(name) && !(isPlural && name === 'count')) problems.push(`${key}: unknown value {${name}}`);
    }
    if (!isPlural) {
      for (const name of wantValues) if (!placeholders(text).includes(name)) problems.push(`${key}: missing value {${name}}`);
    }
    const a = [...tags(english)].sort().join(','), b = [...tags(text)].sort().join(',');
    if (a !== b) problems.push(`${key}: tags <${b}> should be <${a}>`);
  }
  const targetBases = new Set(Object.keys(target).map(baseKey));
  for (const base of targetBases) {
    const forms = Object.keys(target).filter(k => baseKey(k) === base && k !== base);
    if (forms.length && !(`${base}_other` in target)) problems.push(`${base}: plural forms need ${base}_other`);
  }
  return problems;
}
