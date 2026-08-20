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
    /// <summary>
    /// The `^id` anchor within that note. Never the whole note. Empty when the
    /// mentioning block carried no anchor — see <see cref="BlockText"/>.
    /// </summary>
    public string BlockId { get; set; } = string.Empty;

    /// <summary>
    /// The mentioning line as it read at delivery time, used to find the block
    /// again when it has no anchor.
    ///
    /// Anchors are stamped by Papyra's own editor, so a mention written straight
    /// into the `.md` from another tool — which this app invites — carried none,
    /// and used to be dropped in silence. It is still a pointer, not a copy: the
    /// inbox re-finds this line in the author's live note on every read, so an
    /// edited, deleted or locked block goes dark exactly as an anchored one does.
    /// Null for anchored grants, which resolve by <see cref="BlockId"/>.
    /// </summary>
    public string? BlockText { get; set; }

    /// <summary>The mentioned account this grant is for.</summary>
    public int GranteeUserId { get; set; }

    /// <summary>Username of the author at delivery time, for inbox provenance.</summary>
    public string SourceUsername { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; }
    /// <summary>Set when the recipient dismisses the entry; resolution then stops.</summary>
    public DateTime? DismissedUtc { get; set; }
    /// <summary>
    /// Set the first time the recipient opens their inbox. Null means unread, which
    /// is what the sidebar badge counts. Distinct from <see cref="DismissedUtc"/>:
    /// reading an entry only clears the badge, while dismissing it revokes the
    /// grant and removes the entry.
    /// </summary>
    public DateTime? ReadUtc { get; set; }
}
