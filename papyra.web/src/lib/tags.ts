import type { Note } from '../types/note';

/** Mirrors Storage/TagPolicy.cs on the server. */
export const MAX_TAGS_PER_NOTE = 20;
export const MAX_TAG_LENGTH = 40;

export interface TagEntry {
  name: string;
  /** Registry colour, or null until one is picked. */
  color: string | null;
  /** Live notes (not trashed) carrying the tag. */
  count: number;
}

/**
 * Every tag, with its live count. Counts are computed from the notes the client
 * already holds rather than taken from the server's tag list: that list is only
 * refetched when a tag is created or deleted, so adding a tag to a note did not
 * show up until a reload. Built from the notes cache, it moves with every edit.
 *
 * The registry contributes colours and tags that exist before any note uses
 * them. Names match case-insensitively; the first spelling seen wins.
 */
export function buildTags(notes: Note[], registry: { name: string; color: string | null }[]): TagEntry[] {
  const byKey = new Map<string, TagEntry>();
  for (const n of notes) {
    if (n.trashed) continue;
    for (const raw of n.tags ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { name, color: null, count: 1 });
    }
  }
  for (const r of registry) {
    const key = r.name.toLowerCase();
    const entry = byKey.get(key);
    if (entry) entry.color = r.color;
    else byKey.set(key, { name: r.name, color: r.color, count: 0 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Why a tag can't be added to a note right now, or null. */
export function tagProblem(tag: string, current: string[]): string | null {
  const name = tag.trim();
  if (!name) return null;
  if (name.length > MAX_TAG_LENGTH) return `A tag can be at most ${MAX_TAG_LENGTH} characters.`;
  if (current.length >= MAX_TAGS_PER_NOTE) return `A note can have at most ${MAX_TAGS_PER_NOTE} tags.`;
  return null;
}
