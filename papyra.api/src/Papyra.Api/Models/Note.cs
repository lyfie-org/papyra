using System.Text.Json.Serialization;

namespace Papyra.Api.Models;

// The authoritative shape of a note. Lives on disk as a .md file: YAML
// frontmatter (metadata) + markdown body. The DB/index are disposable mirrors.
public class Note
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public List<string> Tags { get; set; } = [];
    public string? Color { get; set; }
    public bool Pinned { get; set; }
    public bool Archived { get; set; }
    // "note" (default) or "todo". A todo note's body is a markdown checklist and
    // it surfaces in the To Do tab instead of the notes desk. Owned frontmatter,
    // but only written when non-default to keep the YAML clean.
    public string Kind { get; set; } = "note";
    // Soft-delete: a trashed note stays on disk (recoverable) until a retention
    // sweep purges it. TrashedAt anchors that retention window.
    public bool Trashed { get; set; }
    public DateTime? TrashedAt { get; set; }
    // YAML `secure: true` marks a note whose Body the API withholds until the caller
    // presents a valid biometric unlock token. The gate is enforced server-side —
    // the client's blur is only cosmetic.
    public bool Secure { get; set; }
    public string Body { get; set; } = string.Empty;

    // Last-modified, surfaced to the client so the grid can default-sort by recency
    // and so an edit always bumps a note above any manual drag position. Sourced
    // from the file mtime on read (DateTime.UtcNow on an in-memory write). NOT
    // written to YAML — it's a derived signal, not owned frontmatter, so sync tools
    // never see churn from it.
    public DateTime Updated { get; set; }

    // Foreign frontmatter keys we don't own (Obsidian/Syncthing/plugin fields).
    // Carried verbatim so the storage engine can round-trip them untouched — even
    // on a fresh write (import) where there's no existing file to merge from.
    // JsonIgnore'd: an internal preservation bag, never part of the API payload.
    [JsonIgnore]
    public Dictionary<string, object?> ExtraFrontmatter { get; set; } = [];
}
