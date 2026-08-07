namespace Papyra.Api.Models;

// A grant of access to one note. Two kinds:
//   "link" — a public tokenised URL (no account needed), optionally limited by
//            an expiry and/or a maximum view count.
//   "user" — an internal grant to another Papyra account (GranteeUserId).
// Access is "view" or "edit". The note itself stays in the owner's vault; a share
// is just an authorisation record pointing at it.
public class Share
{
    public int Id { get; set; }
    public string NoteId { get; set; } = string.Empty;
    public int OwnerId { get; set; }
    public string Kind { get; set; } = "link";     // "link" | "user"
    public string Access { get; set; } = "view";    // "view" | "edit"

    // Link shares only: the opaque URL token.
    public string? Token { get; set; }
    // User shares only: the account the note is shared with.
    public int? GranteeUserId { get; set; }

    // Link limits (null = unlimited).
    public DateTime? ExpiresUtc { get; set; }
    public int? MaxViews { get; set; }
    public int ViewCount { get; set; }

    public DateTime CreatedUtc { get; set; }
}
