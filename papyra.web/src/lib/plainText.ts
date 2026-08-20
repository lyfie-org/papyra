const SNIPPET_LEN = 220;

/**
 * Flattens a note's markdown into the prose a human would read.
 *
 * Used anywhere a note is shown as plain text rather than rendered: the card
 * preview and the offline search fallback. Both used to do their own thing — the
 * card stripped markdown, search sliced the raw body — so the same note appeared
 * clean on a card and littered with `^p5fozaot` block anchors in a search result.
 *
 * Kept in step with `PlainText.Flatten` on the server (Storage/PlainText.cs),
 * which does the same job for Lucene snippets.
 */
export function flattenMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')                    // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')                        // inline code
    .replace(/!\[\[[^\]]*\]\]/g, ' ')                   // media embeds ![[file]]
    // Luthor stamps every block with a trailing `^id` for transclusion. Machine
    // bookkeeping — it must never reach a reader.
    .replace(/(?<=^|[ \t])\^[A-Za-z0-9][A-Za-z0-9_-]*(?=[ \t]|$)/gm, '')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')   // wikilinks [[a|b]] → a
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')              // images ![alt](url)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // links [text](url) → text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                 // headings
    .replace(/^\s{0,3}>\s?/gm, '')                      // blockquotes
    .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, '')      // task list markers
    .replace(/^\s{0,3}[-*+]\s+/gm, '')                  // bullet list markers
    .replace(/^\s{0,3}\d+\.\s+/gm, '')                  // ordered list markers
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')        // horizontal rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                 // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                    // italic
    .replace(/~~(.*?)~~/g, '$2');                       // strikethrough
}

/**
 * Normalise flattened text for display: collapse runs of spaces, trim around
 * newlines, and cap blank-line runs at one.
 *
 * The blank-line cap is what makes a card's line spacing match the open note.
 * Markdown separates paragraphs with a blank line; rendered in the editor that
 * becomes a paragraph margin, but a card (`white-space: pre-wrap`) rendered it as
 * a literal empty line, so the same note looked airier on the card than in the
 * editor.
 */
export function normaliseLines(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Card-length preview of a note body. */
export function snippet(body: string, max = SNIPPET_LEN): string {
  const text = normaliseLines(flattenMarkdown(body));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
