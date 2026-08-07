import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';

export interface SmartCollection {
  id: number;
  name: string;
  rulesJson: string;
  createdUtc: string;
}

export interface SmartRule {
  field: 'tag' | 'color' | 'pinned' | 'kind' | 'text';
  value: string;
}

export interface SmartRules {
  match: 'all' | 'any';
  conditions: SmartRule[];
}

const KEY = ['collections'];

export function useCollections() {
  return useQuery<SmartCollection[]>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch('/api/collections');
      if (!res.ok) throw new Error(`GET /api/collections failed: ${res.status}`);
      return res.json();
    },
  });
}

// The notes a saved collection currently matches (evaluated server-side, live).
export function useCollectionNotes(id: number | null) {
  return useQuery<Note[]>({
    queryKey: ['collection-notes', id],
    enabled: id !== null,
    queryFn: async () => {
      const res = await fetch(`/api/collections/${id}/notes`);
      if (!res.ok) throw new Error(`GET collection notes failed: ${res.status}`);
      return res.json();
    },
  });
}

export function useCreateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; rules: SmartRules }) => {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name, rulesJson: JSON.stringify(input.rules) }),
      });
      if (!res.ok) throw new Error(`POST /api/collections failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/collections/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE /api/collections/${id} failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
