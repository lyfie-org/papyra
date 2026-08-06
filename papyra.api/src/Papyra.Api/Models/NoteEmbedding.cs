namespace Papyra.Api.Models;

// One embedded chunk of a note. Vectors are a derived, disposable cache — the .md
// file stays the source of truth, and the whole table can be dropped and rebuilt.
// UserId is stored alongside NoteId so similarity search can be fenced per tenant.
public class NoteEmbedding
{
    public int Id { get; set; }
    public string NoteId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public int ChunkIndex { get; set; }
    // The chunk's text, kept so a hit can be cited without re-reading the file.
    public string Text { get; set; } = string.Empty;
    // The embedding itself, stored as raw little-endian float32s.
    public byte[] Vector { get; set; } = [];
    public DateTime CreatedUtc { get; set; }
}
