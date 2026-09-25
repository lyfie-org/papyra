// Text-level CommonMark the editor writes into note files, for the places that
// show a note without the editor (card previews, plain-text snippets):
//
// - backslash escapes (`\*`, `\_`, `\#`…): a literal character, never syntax;
// - numeric character references (`&#35;`, `&#91;`, `&#8203;`…): the editor
//   writes these for text that would otherwise read as syntax — "1. " typed
//   as words, a lone "[ ] " — and `&#8203;` for an empty line in a paragraph.
//
// Escapes are swapped for private-use stand-ins *before* markdown is parsed (so
// `\*x\*` can't become italics) and put back afterwards; references are decoded
// only in finished text (so `&#35; x` shows "# x" but never becomes a heading).

const ESCAPE = /\\([!-/:-@[-`{-~])/g;
const BASE = 0xf800;

/** `\*` → a stand-in the markdown patterns don't recognise. */
export function protectEscapes(md: string): string {
  return md.replace(ESCAPE, (_, ch: string) => String.fromCharCode(BASE + ch.charCodeAt(0)));
}

/** Stand-ins back to the literal character (`keepBackslash` inside code, where `\` is literal). */
export function restoreEscapes(text: string, keepBackslash = false): string {
  return text.replace(/[-]/g, (c) => {
    const ch = String.fromCharCode(c.charCodeAt(0) - BASE);
    return keepBackslash ? `\\${ch}` : ch;
  });
}

/** `&#35;` / `&#x23;` → `#`; the zero-width empty-line marker disappears. */
export function decodeReferences(text: string): string {
  return text
    .replace(/&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (whole, dec?: string, hex?: string) => {
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    })
    .replace(new RegExp('\\u200B', 'g'), '');
}

/** Finished prose: references decoded, escapes back to their characters. */
export const finishText = (text: string): string => restoreEscapes(decodeReferences(text));

/** Finished code: shown exactly as written. */
export const finishCode = (text: string): string => restoreEscapes(text, true);
