namespace Papyra.Api.Models;

// Frontmatter-only projection of a note — no body content.
// Lives in the in-memory dict; reconstructable from .md files at any time.
public sealed record NoteMetadata(
    string       Id,
    string       Title,
    List<string> Tags,
    bool         Pinned,
    string       Color,
    string       Owner,
    bool         Archived,
    bool         Deleted,
    DateTime     CreatedAt,
    DateTime     UpdatedAt
);
