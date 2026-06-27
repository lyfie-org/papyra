import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface Share {
  id: number;
  kind: 'link' | 'user';
  access: 'view' | 'edit';
  token: string | null;
  expiresUtc: string | null;
  maxViews: number | null;
  viewCount: number;
  grantee: string | null;
}

export interface IncomingShare {
  shareId: number;
  noteId: string;
  owner: string;
  title: string;
  access: 'view' | 'edit';
}

export interface CreateShareInput {
  kind: 'link' | 'user';
  access: 'view' | 'edit';
  granteeUsername?: string;
  expiresUtc?: string | null;
  maxViews?: number | null;
}

export function useNoteShares(noteId: string) {
  return useQuery({
    queryKey: ['shares', noteId],
    queryFn: async (): Promise<Share[]> => {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/shares`);
      if (!res.ok) throw new Error(`GET shares failed: ${res.status}`);
      return res.json();
    },
  });
}

export function useCreateShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateShareInput) => {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `POST share failed: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares', noteId] }),
  });
}

export function useRevokeShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (shareId: number) => {
      const res = await fetch(`/api/shares/${shareId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE share failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares', noteId] }),
  });
}

export function useIncomingShares() {
  return useQuery({
    queryKey: ['shares', 'incoming'],
    queryFn: async (): Promise<IncomingShare[]> => {
      const res = await fetch('/api/shares/incoming');
      if (!res.ok) throw new Error(`GET incoming shares failed: ${res.status}`);
      return res.json();
    },
  });
}
