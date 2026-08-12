namespace Papyra.Api.Models;

// Authorisation to read ONE anchored block of someone else's note.
//
// Mentioning `@someone` in a note delivers a reference to that block into their
// inbox. Resolving it later is a cross-tenant read, and PathGuard jails each
// tenant to its own directory — so a grant row is the only thing that permits
// it, exactly as a Share row is the only thing that permits reading a whole
// note. The block stays in the author's vault; this is a pointer, not a copy.
public class BlockGrant
{
    public int Id { get; set; }

    /// <summary>The author whose vault holds the block.</summary>
    public int SourceOwnerId { get; set; }
    public string SourceNoteId { get; set; } = string.Empty;
    /// <summary>The `^id` anchor within that note. Never the whole note.</summary>
    public string BlockId { get; set; } = string.Empty;

    /// <summary>The mentioned account this grant is for.</summary>
    public int GranteeUserId { get; set; }

    /// <summary>Username of the author at delivery time, for inbox provenance.</summary>
    public string SourceUsername { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; }
    /// <summary>Set when the recipient dismisses the entry; resolution then stops.</summary>
    public DateTime? DismissedUtc { get; set; }
}
