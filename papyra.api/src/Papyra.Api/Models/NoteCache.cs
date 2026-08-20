namespace Papyra.Api.Models;

// Disposable relational mirror of a note's metadata. Body lives only on disk.
//
// Keyed by (UserId, Id), never by Id alone. A note id is only unique *within* a
// tenant's vault — two tenants routinely hold the same id (every user who has
// ever been @mentioned owns a note with id "Inbox"; two users importing the same
// file get the same filename-derived id). Keying on Id alone made the second
// tenant's row a duplicate-key insert, which crashed the cold-boot reconciler
// before Kestrel opened its ports — an unbootable instance, not a degraded one.
public class NoteCache
{
    /// <summary>Owning tenant. Part of the primary key — a note id is unique only within a vault.</summary>
    public string UserId { get; set; } = string.Empty;
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Tags { get; set; } = string.Empty;
    public DateTime LastModified { get; set; }
}
