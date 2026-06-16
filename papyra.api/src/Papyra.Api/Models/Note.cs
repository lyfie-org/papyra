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
}
