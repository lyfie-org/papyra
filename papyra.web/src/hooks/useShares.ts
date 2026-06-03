import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sharesApi } from '../api/shares';
import type { CreateShareRequest, PublicLinkRequest } from '../types';

const shareKey = (noteId: string) => ['shares', noteId] as const;

export function useShares(noteId: string | null) {
  return useQuery({
    queryKey: shareKey(noteId ?? ''),
    queryFn:  () => sharesApi.list(noteId!),
    enabled:  noteId !== null,
  });
}

export function useCreateShare(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateShareRequest) => sharesApi.create(noteId, req),
    onSuccess:  () => qc.invalidateQueries({ queryKey: shareKey(noteId) }),
  });
}

export function useRemoveShare(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => sharesApi.remove(noteId, shareId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: shareKey(noteId) }),
  });
}

export function useCreatePublicLink(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PublicLinkRequest) => sharesApi.createPublicLink(noteId, req),
    onSuccess:  () => qc.invalidateQueries({ queryKey: shareKey(noteId) }),
  });
}

export function useRevokePublicLink(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => sharesApi.revokePublicLink(noteId, shareId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: shareKey(noteId) }),
  });
}
