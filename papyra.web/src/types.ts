export interface Note {
  id: string;
  title: string;
  tags: string[];
  pinned: boolean;
  color: string;
  content: string;
}

/** Returned by GET /notes — content is omitted for bandwidth. */
export type NoteSummary = Omit<Note, 'content'>;

export interface SearchHit extends NoteSummary {
  snippet: string;
}

export interface CreateNoteRequest {
  title: string;
  tags?: string[];
  color?: string;
}

export interface UpdateNoteRequest {
  title?: string;
  tags?: string[];
  pinned?: boolean;
  color?: string;
  content?: string;
}
