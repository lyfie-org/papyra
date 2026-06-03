import client from './client';
import type { CreateShareRequest, PublicLinkRequest, PublicLinkResponse, ShareRecord } from '../types';

export const sharesApi = {
  list: (noteId: string): Promise<ShareRecord[]> =>
    client.get<ShareRecord[]>(`/api/notes/${noteId}/shares`).then(r => r.data),

  create: (noteId: string, req: CreateShareRequest): Promise<ShareRecord> =>
    client.post<ShareRecord>(`/api/notes/${noteId}/shares`, req).then(r => r.data),

  remove: (noteId: string, shareId: string): Promise<void> =>
    client.delete(`/api/notes/${noteId}/shares/${shareId}`).then(() => undefined),

  createPublicLink: (noteId: string, req: PublicLinkRequest): Promise<PublicLinkResponse> =>
    client.post<PublicLinkResponse>(`/api/notes/${noteId}/shares/public`, req).then(r => r.data),

  revokePublicLink: (noteId: string, shareId: string): Promise<void> =>
    client.delete(`/api/notes/${noteId}/shares/${shareId}`).then(() => undefined),
};
