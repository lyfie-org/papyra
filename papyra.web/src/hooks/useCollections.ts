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

export function useUpdateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; name: string; rules: SmartRules }) => {
      const res = await fetch(`/api/collections/${input.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name, rulesJson: JSON.stringify(input.rules) }),
      });
      if (!res.ok) throw new Error(`PUT /api/collections/${input.id} failed: ${res.status}`);
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

/** Why a collection request failed, in the server's own words when it sent some. */
async function failure(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/**
 * A collection as shareable JSON — `{papyraCollection: 1, name, rules}`, its
 * name and rules only — pretty-printed for copying.
 */
export function useCollectionExport(id: number) {
  return useQuery<string>({
    queryKey: [...KEY, id, 'export'],
    queryFn: async () => {
      const res = await fetch(`/api/collections/${id}/export`);
      if (!res.ok) throw await failure(res, 'Couldn’t read this collection.');
      return JSON.stringify(await res.json(), null, 2);
    },
    staleTime: 0,
  });
}

/** Offer a copy of a collection to someone here; it lands in their notifications. */
export function useSendCollection() {
  return useMutation({
    mutationFn: async (input: { id: number; username: string }) => {
      const res = await fetch(`/api/collections/${input.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: input.username }),
      });
      if (!res.ok) throw await failure(res, 'Couldn’t send the collection.');
      return (await res.json()) as { recipient: string };
    },
  });
}

/** Add a collection from pasted JSON. The server numbers a name that's taken. */
export function useImportCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: string): Promise<SmartCollection> => {
      let parsed: unknown;
      try { parsed = JSON.parse(json); } catch { throw new Error('That isn’t a Papyra collection — the text isn’t valid JSON.'); }
      const res = await fetch('/api/collections/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) throw await failure(res, 'Couldn’t add that collection.');
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
