/**
 * The letters a face shows with no picture: the first letters of a person's
 * first and last name ("Ada Lovelace" → "AL"), one letter for a one-word name,
 * the username's first letter when there is no name.
 */
export function initialsOf(name?: string | null, username?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
    // "Ada (work)" or "— Ada": start each word at its first letter or digit.
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  const first = (w: string) => Array.from(w)[0] ?? '';
  if (words.length >= 2) return (first(words[0]) + first(words[words.length - 1])).toUpperCase();
  if (words.length === 1) return first(words[0]).toUpperCase();
  return first((username ?? '').replace(/^@/, '')).toUpperCase() || '?';
}
