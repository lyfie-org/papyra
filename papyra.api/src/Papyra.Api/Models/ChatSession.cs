namespace Papyra.Api.Models;

/// <summary>
/// One conversation with the assistant.
///
/// The assistant used to forget everything the moment the panel closed, which
/// made a follow-up question impossible: "what about the second one?" had
/// nothing to refer to. A session is the thread those questions hang from.
///
/// Sessions belong to one account and never leave it — the assistant answers
/// from that person's notes, so its history is as private as the notes are.
/// </summary>
public class ChatSession
{
    public int Id { get; set; }
    public int UserId { get; set; }

    /// <summary>Taken from the first question, and editable afterwards.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>
    /// Which model answered, recorded per session rather than read from settings:
    /// an admin can switch models between conversations, and a thread that reads
    /// oddly is worth being able to attribute.
    /// </summary>
    public string Model { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    /// <summary>Last message, so the list can be most-recent-first.</summary>
    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;
}

/// <summary>One turn in a conversation.</summary>
public class ChatMessage
{
    public int Id { get; set; }
    public int SessionId { get; set; }

    /// <summary>"user" or "assistant".</summary>
    public string Role { get; set; } = "user";
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// The notes an assistant turn was grounded in, as JSON. Stored with the
    /// message rather than looked up again later: a citation is a record of what
    /// the answer was based on at the time, and the note may since have changed
    /// or been deleted.
    /// </summary>
    public string? CitationsJson { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
