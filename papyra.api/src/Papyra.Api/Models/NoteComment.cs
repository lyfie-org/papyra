namespace Papyra.Api.Models;

// A comment on a note, Google-Docs style: a thread anchored to a passage of the
// note, with replies and reactions. Anyone who can see the note — its owner, or
// someone it is shared with (view or edit) — can comment.
//
// The note's .md stays untouched: a thread remembers its passage as a W3C
// TextQuoteSelector (the exact text plus a little context either side), and the
// editor finds it again in the rendered note. Edit the passage away and the
// thread becomes "detached" — still listed, no longer highlighted — rather than
// silently pointing at the wrong words. Comments live here, beside the shares
// that decide who may read them, not in the vault.
public class NoteComment
{
    public int Id { get; set; }

    /// <summary>The note: owner's vault + id.</summary>
    public int OwnerId { get; set; }
    public string NoteId { get; set; } = string.Empty;

    /// <summary>Null on the thread's first comment; the root's id on a reply.</summary>
    public int? ThreadId { get; set; }

    public int AuthorId { get; set; }
    public string Body { get; set; } = string.Empty;

    // Root only: the passage it is about. Null exact = a comment on the whole note.
    public string? QuoteExact { get; set; }
    public string? QuotePrefix { get; set; }
    public string? QuoteSuffix { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime? EditedUtc { get; set; }

    // Root only.
    public DateTime? ResolvedUtc { get; set; }
    public int? ResolvedById { get; set; }
}

/// <summary>One person's emoji on one comment.</summary>
public class CommentReaction
{
    public int Id { get; set; }
    public int CommentId { get; set; }
    public int UserId { get; set; }
    public string Emoji { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
}
