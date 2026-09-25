import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SmartRules } from '../lib/smartCollections';

export type { SmartRule, SmartRules } from '../lib/smartCollections';

export interface SmartCollection {
  id: number;
  name: string;
  rulesJson: string;
  createdUtc: string;
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
