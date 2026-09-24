import type { QueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';

/**
 * Show a frontmatter change (colour, pin, archive, tags…) straight away by
 * patching the cached note list, before the PUT and the full-list refetch that
 * follows it. Without this a colour pick waited on two round trips to appear,
 * which is most of why it felt sluggish. The refetch still lands afterwards and
 * is the truth; if the write fails, that refetch puts the old value back.
 *
 * Frontmatter only: never pass title/body here. The open editor compares the
 * cached body with what it shows to detect remote edits, and a draft written
 * into the cache would read as one.
 */
export function patchNoteInCache(
  queryClient: QueryClient,
  id: string,
  patch: Partial<Pick<Note, 'color' | 'pinned' | 'archived' | 'tags' | 'kind' | 'secure'>>,
): void {
  queryClient.setQueryData<Note[]>(['notes'], (prev) =>
    prev?.map((n) => (n.id === id ? { ...n, ...patch } : n)));
}
