namespace Papyra.Api.Models;

// One entry in a user's notification tray (the bell in the top bar): someone
// mentioned you, shared a note with you, gave you edit access, asked for access
// to one of your notes, or answered a request you made.
//
// A row is an event, not a grant — access is always decided by Share rows, and
// what a notification may reveal about a note (its title, the mentioning line)
// is re-checked against those on every read.
public class Notification
{
    public int Id { get; set; }

    /// <summary>Recipient.</summary>
    public int UserId { get; set; }

    /// <summary>
    /// "mention" | "shared" | "access_upgraded" | "access_requested" |
    /// "access_approved" | "access_denied".
    /// </summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Who did it.</summary>
    public int ActorUserId { get; set; }

    /// <summary>The note it is about: owner's vault + id.</summary>
    public int OwnerId { get; set; }
    public string NoteId { get; set; } = string.Empty;

    /// <summary>"view" | "edit" where the event carries an access level.</summary>
    public string? Access { get; set; }

    /// <summary>The access request an access_* event is about.</summary>
    public int? AccessRequestId { get; set; }
    /// <summary>The mention (BlockGrant) a "mention" event is about.</summary>
    public int? BlockGrantId { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime? ReadUtc { get; set; }
    public DateTime? DismissedUtc { get; set; }
}
