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
    public string Body { get; set; } = string.Empty;

    // Foreign frontmatter keys we don't own (Obsidian/Syncthing/plugin fields).
    // Carried verbatim so the storage engine can round-trip them untouched — even
    // on a fresh write (import) where there's no existing file to merge from.
    // JsonIgnore'd: an internal preservation bag, never part of the API payload.
    [JsonIgnore]
    public Dictionary<string, object?> ExtraFrontmatter { get; set; } = [];
}
