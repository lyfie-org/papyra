// Text helpers for the journal's page. The word count mirrors the server's
// (`JournalService.CountWords`), so the footer and the calendar never disagree.

const NON_WORDS = /!\[\[[^\]]*\]\]|https?:\/\/\S+|\^[A-Za-z0-9_-]+/g;
// A run of letters is a word; each kana/ideograph counts as its own (no spaces to count by).
const WORD = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function countWords(markdown: string | null | undefined): number {
  if (!markdown || !markdown.trim()) return 0;
  return markdown.replace(NON_WORDS, ' ').match(WORD)?.length ?? 0;
}

const OPEN_ITEM = /^[ \t]*[-*+][ \t]+\[ \][ \t]+\S/gm;

/** How many unticked checklist items a to-do's markdown has. */
export function openItemCount(body: string): number {
  return body.match(OPEN_ITEM)?.length ?? 0;
}
