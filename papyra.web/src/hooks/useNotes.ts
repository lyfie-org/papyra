import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { notesApi } from '../api/notes';
import client from '../api/client';
import { useOfflineQueue } from '../context/OfflineQueueContext';
import type { CreateNoteRequest, Note, NoteSummary, UpdateNoteRequest } from '../types';

export const NOTES_KEY = ['notes'] as const;
export const noteKey = (id: string) => ['notes', id] as const;

// ── Queries ───────────────────────────────────────────────────────────────────

export function useNotes() {
  return useQuery({
    queryKey: NOTES_KEY,
    queryFn: notesApi.list,
  });
}

export function useSearchNotes(query: string) {
  return useQuery({
    queryKey: ['notes', 'search', query],
    queryFn: () => notesApi.search(query),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useNote(id: string) {
  return useQuery({
    queryKey: noteKey(id),
    queryFn: () => notesApi.get(id),
    enabled: Boolean(id),
  });
}

// ── Mutations with optimistic updates ────────────────────────────────────────

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateNoteRequest) => notesApi.create(req),

    onMutate: async (req) => {
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      const prev = qc.getQueryData<NoteSummary[]>(NOTES_KEY) ?? [];
      const optimistic: NoteSummary = {
        id: `temp-${Date.now()}`,
        title: req.title,
        tags: req.tags ?? [],
        pinned: false,
        color: req.color ?? '',
      };
      qc.setQueryData<NoteSummary[]>(NOTES_KEY, [...prev, optimistic]);
      return { prev };
    },
    onError: (_err, _req, ctx) => {
      if (ctx?.prev) qc.setQueryData(NOTES_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: NOTES_KEY }),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  const { queueUpdate } = useOfflineQueue();

  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateNoteRequest }) =>
      notesApi.update(id, req),

    onMutate: async ({ id, req }) => {
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      await qc.cancelQueries({ queryKey: noteKey(id) });

      const prevList = qc.getQueryData<NoteSummary[]>(NOTES_KEY);
      const prevNote = qc.getQueryData<Note>(noteKey(id));

      // Strip content from the summary update (list doesn't carry content)
      const { content: _content, ...summaryUpdate } = req;
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).map(n => n.id === id ? { ...n, ...summaryUpdate } : n),
      );
      if (prevNote) {
        qc.setQueryData<Note>(noteKey(id), { ...prevNote, ...req });
      }

      return { prevList, prevNote };
    },
    onError: async (_err, { id, req }, ctx) => {
      if (!navigator.onLine) {
        // Offline: preserve optimistic update and queue for replay on reconnect
        await queueUpdate(id, req);
        return;
      }
      // Online error: roll back optimistic update
      if (ctx?.prevList) qc.setQueryData(NOTES_KEY, ctx.prevList);
      if (ctx?.prevNote) qc.setQueryData(noteKey(id), ctx.prevNote);
    },
    onSettled: (_data, err, { id }) => {
      // Skip invalidation if we queued offline (navigator.onLine check not reliable here,
      // but the queueUpdate path returns early before onSettled can double-invalidate)
      if (!err || navigator.onLine) {
        qc.invalidateQueries({ queryKey: NOTES_KEY });
        qc.invalidateQueries({ queryKey: noteKey(id) });
      }
    },
  });
}

export function useArchiveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.patch(`/api/notes/${id}/archive`),

    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      const prev = qc.getQueryData<NoteSummary[]>(NOTES_KEY);
      qc.setQueryData<NoteSummary[]>(NOTES_KEY, old => (old ?? []).filter(n => n.id !== id));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(NOTES_KEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      qc.invalidateQueries({ queryKey: ['notes', 'archived'] });
    },
  });
}

export function useTrashNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.patch(`/api/notes/${id}/trash`),

    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      const prev = qc.getQueryData<NoteSummary[]>(NOTES_KEY);
      qc.setQueryData<NoteSummary[]>(NOTES_KEY, old => (old ?? []).filter(n => n.id !== id));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(NOTES_KEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      qc.invalidateQueries({ queryKey: ['notes', 'trash'] });
    },
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notesApi.delete(id),

    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      const prev = qc.getQueryData<NoteSummary[]>(NOTES_KEY);
      qc.setQueryData<NoteSummary[]>(NOTES_KEY,
        old => (old ?? []).filter(n => n.id !== id),
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(NOTES_KEY, ctx.prev);
    },
    onSettled: (_data, _err, id) => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      qc.removeQueries({ queryKey: noteKey(id) });
    },
  });
}
