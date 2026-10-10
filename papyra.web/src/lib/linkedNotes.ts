import type { Note } from '../types/note';

// `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`, `![[Target#^block]]`.
const WIKILINK = /!?\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g;
// Embeds of things that are not notes: `![[youtube:…]]`, `![[photo.png]]`.
const NOT_A_NOTE = /^(?:youtube|iframe|card):|\.[a-z0-9]{1,8}$/i;
const FENCE = /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * The notes a body links to, by the names it uses — each once, in the order
 * they first appear. A heading or block part (`#…`) is dropped; attachments,
 * web embeds and anything inside code are not links to notes.
 */
export function linkTargets(body: string): string[] {
  const text = body.replace(FENCE, ' ').replace(INLINE_CODE, ' ');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1].split('#')[0].trim();
    if (!target || NOT_A_NOTE.test(target)) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * The notes of yours a note links to, resolved the way the editor resolves a
 * link (by title, then by id), leaving out the note itself, notes in Trash and
 * locked notes (which are never shared).
 */
export function linkedNotes(note: Pick<Note, 'id' | 'body'>, notes: readonly Note[]): Note[] {
  const live = notes.filter((n) => !n.trashed && !n.secure && n.id !== note.id);
  const byTitle = new Map<string, Note>();
  for (const n of live) {
    const t = n.title.trim().toLowerCase();
    if (t && !byTitle.has(t)) byTitle.set(t, n);
  }
  const byId = new Map(live.map((n) => [n.id.toLowerCase(), n]));
  const found = new Map<string, Note>();
  for (const target of linkTargets(note.body)) {
    const key = target.toLowerCase();
    const hit = byTitle.get(key) ?? byId.get(key);
    if (hit) found.set(hit.id, hit);
  }
  return [...found.values()];
}
