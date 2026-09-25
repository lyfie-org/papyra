import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNotes } from './useNotes';
import { buildTags, type TagEntry } from '../lib/tags';

export type { TagEntry } from '../lib/tags';

// The registry lives at /api/categories (the path predates the rename to tags and
// stays for existing clients). It holds colours and tags created before any note
// used them; counts come from the live notes — see buildTags.
export const TAG_REGISTRY_KEY = ['categories'] as const;

interface RegistryEntry { name: string; color: string | null; count: number }

async function fetchRegistry(): Promise<RegistryEntry[]> {
  const res = await fetch('/api/categories');
  if (!res.ok) throw new Error(`GET /api/categories failed: ${res.status}`);
  return res.json();
}

/** Every tag with its live note count (moves with each note edit, no refetch). */
export function useTags(): { data: TagEntry[] | undefined; isLoading: boolean } {
  const registry = useQuery({ queryKey: TAG_REGISTRY_KEY, queryFn: fetchRegistry });
  const notes = useNotes();
  const data = useMemo(
    () => (notes.data && registry.data ? buildTags(notes.data, registry.data) : undefined),
    [notes.data, registry.data],
  );
  return { data, isLoading: notes.isLoading || registry.isLoading };
}

export function useCreateTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; color?: string | null }) => {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/categories failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TAG_REGISTRY_KEY }),
  });
}

/** Delete a tag everywhere: the registry entry and the tag on every note carrying it. */
export function useDeleteTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/categories/${encodeURIComponent(name)}?fromNotes=true`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE /api/categories failed: ${res.status}`);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TAG_REGISTRY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['notes'] }),
      ]);
    },
  });
}
