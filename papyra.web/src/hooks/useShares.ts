import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShareSummary } from '../components/ShareBadge';

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
  /** Plain-text opening of the note, for the card. */
  excerpt: string;
  color: string | null;
  updatedUtc: string | null;
  /** The caller has asked the owner for edit access and is waiting. */
  requestPending: boolean;
}

/** Someone asking me for access to one of my notes. */
export interface AccessRequest {
  id: number;
  noteId: string;
  title: string;
  requester: string;
  requesterName: string | null;
  access: 'view' | 'edit';
  /** What they hold today, if anything — a view share asking to edit. */
  currentAccess: 'view' | 'edit' | null;
  createdUtc: string;
}

export const ACCESS_REQUESTS_KEY = ['access-requests'] as const;

export interface CreateShareInput {
  kind: 'link' | 'user';
  access: 'view' | 'edit';
  granteeUsername?: string;
  expiresUtc?: string | null;
  maxViews?: number | null;
}

/**
 * Who can see which of my notes, in one request.
 *
 * Every card that is shared needs to say so, and asking per card is a request
 * per card. `staleTime` keeps a grid scroll from re-fetching: sharing is a
 * deliberate act, and the mutations that perform it invalidate this key.
 */
export function useShareSummary() {
  return useQuery({
    queryKey: ['shares', 'summary'],
    staleTime: 30_000,
    queryFn: async (): Promise<ShareSummary[]> => {
      const res = await fetch('/api/shares/summary');
      if (!res.ok) throw new Error(`GET share summary failed: ${res.status}`);
      return res.json();
    },
  });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shares', noteId] });
      void queryClient.invalidateQueries({ queryKey: ['shares', 'summary'] });
    },
  });
}

export function useRevokeShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (shareId: number) => {
      const res = await fetch(`/api/shares/${shareId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE share failed: ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shares', noteId] });
      // A revoked share changes the card's badge as much as a new one does, and
      // ['shares', noteId] is not a prefix of ['shares', 'summary'].
      void queryClient.invalidateQueries({ queryKey: ['shares', 'summary'] });
    },
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

/** Requests waiting on the signed-in owner. */
export function useAccessRequests() {
  return useQuery({
    queryKey: ACCESS_REQUESTS_KEY,
    queryFn: async (): Promise<AccessRequest[]> => {
      const res = await fetch('/api/access-requests/incoming');
      if (!res.ok) throw new Error(`GET access requests failed: ${res.status}`);
      return res.json();
    },
  });
}

/**
 * Ask a note's owner for access — from a read-only share (`shareId`) or from a
 * mention in the inbox (`inboxId`). Asking twice is the same request.
 */
export function useRequestAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { shareId?: number; inboxId?: number; access: 'view' | 'edit' }) => {
      const res = await fetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Request failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shares', 'incoming'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

/** Owner's answer to a request. `approve` may grant less than was asked. */
export function useAnswerAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; approve: boolean; access?: 'view' | 'edit' }) => {
      const res = await fetch(`/api/access-requests/${input.id}/${input.approve ? 'approve' : 'deny'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.approve ? { access: input.access ?? null } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Couldn’t answer that request (${res.status}).`);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}
