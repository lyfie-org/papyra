namespace Papyra.Api.Models;

// Someone asking the owner of a note for (more) access to it — the "Request
// access" / "Request edit access" flow familiar from Google Docs.
//
// A request can only be raised by someone who already has a reason to know the
// note exists: a read-only Share of it, or a mention (BlockGrant) pointing into
// it. That keeps this from becoming a probe for arbitrary note ids in other
// people's vaults. Approving it creates or upgrades the Share; the request row is
// kept afterwards as the record of who asked and what the owner decided.
public class AccessRequest
{
    public int Id { get; set; }

    /// <summary>The owner of the note — the only person who can decide.</summary>
    public int OwnerId { get; set; }
    public string NoteId { get; set; } = string.Empty;

    /// <summary>The account asking.</summary>
    public int RequesterUserId { get; set; }

    /// <summary>What was asked for: "view" or "edit".</summary>
    public string Access { get; set; } = "edit";

    /// <summary>"pending" | "approved" | "denied".</summary>
    public string Status { get; set; } = "pending";

    public DateTime CreatedUtc { get; set; }
    public DateTime? ResolvedUtc { get; set; }
}
