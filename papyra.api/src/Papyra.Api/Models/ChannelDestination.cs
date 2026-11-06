namespace Papyra.Api.Models;

/// <summary>
/// Where one person's notifications go on a chat service other than email: their ntfy topic, their
/// Telegram chat, their Discord DM or channel webhook. One row per person per channel.
///
/// Email needs no row — it goes to the address on the account. Everything else a destination holds
/// is either a plain handle (<see cref="Handle"/>) or a secret that is sealed before it is stored
/// (<see cref="SecretSealed"/>, see <c>SecretBox</c>).
/// </summary>
public class ChannelDestination
{
    public int Id { get; set; }
    public int UserId { get; set; }

    /// <summary>"discord" | "telegram" | "ntfy" (see <c>NotificationCatalog.Channels</c>).</summary>
    public string Channel { get; set; } = string.Empty;

    /// <summary>Which way the channel is used, when it has more than one ("webhook" | "dm" for Discord).</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>A handle that is not a secret: a Discord user id, a Telegram chat id.</summary>
    public string Handle { get; set; } = string.Empty;

    /// <summary>A secret part of the address (a webhook URL, an ntfy topic), sealed.</summary>
    public string? SecretSealed { get; set; }

    /// <summary>What the person sees on the card: "Telegram · @rahul", "Discord channel".</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>The person has proved this address is theirs. Nothing real is sent before that.</summary>
    public bool Verified { get; set; }

    /// <summary>The person's own switch.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>"minimal" (a generic line and a link) or "titles" (adds the subject, e.g. a note's title).</summary>
    public string PrivacyTier { get; set; } = ChannelPrivacy.Minimal;

    public DateTime CreatedUtc { get; set; }
    public DateTime? LastOkUtc { get; set; }
    public DateTime? LastErrorUtc { get; set; }
    public string? LastError { get; set; }

    /// <summary>Messages in a row that were given up on. Reset by a success.</summary>
    public int ConsecutiveFailures { get; set; }

    /// <summary>
    /// Set when Papyra stopped sending here (a refusal that won't heal, or too many failures in a row).
    /// The person is told once by email and turns it back on from the card.
    /// </summary>
    public DateTime? PausedUtc { get; set; }
}

public static class ChannelPrivacy
{
    public const string Minimal = "minimal";
    public const string Titles = "titles";

    public static string Normalize(string? tier) =>
        string.Equals(tier?.Trim(), Titles, StringComparison.OrdinalIgnoreCase) ? Titles : Minimal;
}

/// <summary>
/// One message waiting to go to (or already sent to) a <see cref="ChannelDestination"/>. Kept in the
/// database, not in memory, so a restart doesn't lose a retry that is due in an hour. The text is
/// cleared as soon as the message is sent or given up on.
/// </summary>
public class ChannelDelivery
{
    public long Id { get; set; }
    public int DestinationId { get; set; }
    public int UserId { get; set; }
    public string Channel { get; set; } = string.Empty;
    public string EventId { get; set; } = string.Empty;

    /// <summary>The line to send, already shaped for the destination's privacy tier. Cleared when done.</summary>
    public string Title { get; set; } = string.Empty;
    public string? Link { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime NextAttemptUtc { get; set; }
    public int Attempts { get; set; }

    /// <summary><see cref="ChannelDeliveryStatus"/>.</summary>
    public string Status { get; set; } = ChannelDeliveryStatus.Pending;
    public string? LastError { get; set; }
    public DateTime? DoneUtc { get; set; }
}

public static class ChannelDeliveryStatus
{
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Failed = "failed";
    /// <summary>Not sent on purpose: the destination was removed, switched off, paused or its channel turned off.</summary>
    public const string Dropped = "dropped";
}
