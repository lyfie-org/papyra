namespace Papyra.Api.Models;

// Disposable relational mirror of a note's metadata. Body lives only on disk.
public class NoteCache
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Tags { get; set; } = string.Empty;
    public DateTime LastModified { get; set; }
}
