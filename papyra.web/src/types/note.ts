// Note metadata as broadcast by the API (YAML frontmatter + body).
// Filesystem `.md` is the source of truth; this mirrors its shape.
export interface Note {
  id: string;
  title: string;
  tags: string[];
  color: string | null;
  pinned: boolean;
  archived: boolean;
  // "note" (default), "todo", or "inbox". Todo notes hold a markdown checklist
  // body and live in the To Do tab; the single "inbox" note per user collects
  // blocks other people have @mentioned them in, and is rendered by /inbox.
  kind: 'note' | 'todo' | 'inbox';
  trashed: boolean;
  trashedAt?: string | null;
  // YAML `secure: true`. The API withholds the body of a secure note until a
  // biometric unlock token is presented, so `body` arrives empty until unlocked.
  secure?: boolean;
  // Last-modified (ISO). Drives the default recency sort and the "edit bumps to
  // top" rule that overrides a stale manual drag position.
  updated: string;
  body: string;
}
