import type { Note, NoteSummary, CreateNoteRequest, UpdateNoteRequest, SearchHit } from '../types';
import client from './client';

export const notesApi = {
  list: (): Promise<NoteSummary[]> =>
    client.get<NoteSummary[]>('/notes').then(r => r.data),

  get: (id: string): Promise<Note> =>
    client.get<Note>(`/notes/${id}`).then(r => r.data),

  create: (req: CreateNoteRequest): Promise<{ id: string }> =>
    client.post<{ id: string }>('/notes', req).then(r => r.data),

  update: (id: string, req: UpdateNoteRequest, idempotencyKey?: string): Promise<void> =>
    client.put(`/notes/${id}`, req, {
      headers: idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined,
    }).then(() => undefined),

  delete: (id: string): Promise<void> =>
    client.delete(`/notes/${id}`).then(() => undefined),

  search: (q: string): Promise<SearchHit[]> =>
    client.get<SearchHit[]>('/search', { params: { q } }).then(r => r.data),

  fuzzySearch: (q: string, limit = 10): Promise<NoteSummary[]> =>
    client.get<NoteSummary[]>('/api/search/fuzzy', { params: { q, limit } }).then(r => r.data),
};
