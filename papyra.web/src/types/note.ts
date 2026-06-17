// Note metadata as broadcast by the API (YAML frontmatter + body).
// Filesystem `.md` is the source of truth; this mirrors its shape.
export interface Note {
  id: string;
  title: string;
  tags: string[];
  color: string | null;
  pinned: boolean;
  archived: boolean;
  body: string;
}
