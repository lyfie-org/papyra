// Note metadata as broadcast by the API (YAML frontmatter + body).
// Filesystem `.md` is the source of truth; this mirrors its shape.
export interface Note {
  id: string;
  title: string;
  tags: string[];
  color: string | null;
  pinned: boolean;
  archived: boolean;
  // "note" (default) or "todo". Todo notes hold a markdown checklist body and
  // live in the To Do tab instead of the notes desk.
  kind: 'note' | 'todo';
  trashed: boolean;
  trashedAt?: string | null;
  // Last-modified (ISO). Drives the default recency sort and the "edit bumps to
  // top" rule that overrides a stale manual drag position.
  updated: string;
  body: string;
}
