using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

/// <summary>What goes to a chat service: one short line and, when Papyra knows its address, a link back.</summary>
public sealed record ChannelMessage(string EventId, string Title, string? Link);

public enum ChannelOutcome
{
    /// <summary>It arrived.</summary>
    Sent,
    /// <summary>A hiccup (network, a 5xx, a rate limit): try again later.</summary>
    Retry,
    /// <summary>The service said no and will keep saying it: a revoked token, a deleted webhook, a blocked bot.</summary>
    Rejected,
}

/// <param name="Outcome">How it went.</param>
/// <param name="Error">What to show the person on the card. Plain words, never a secret or a raw response.</param>
/// <param name="RetryAfter">What the service asked for (<c>Retry-After</c>, Discord's reset time), if it did.</param>
public sealed record ChannelSendResult(ChannelOutcome Outcome, string? Error = null, TimeSpan? RetryAfter = null)
{
    public static ChannelSendResult Ok { get; } = new(ChannelOutcome.Sent);
    public static ChannelSendResult Retry(string error, TimeSpan? after = null) => new(ChannelOutcome.Retry, error, after);
    public static ChannelSendResult Rejected(string error) => new(ChannelOutcome.Rejected, error);
}

/// <summary>
/// One chat service Papyra can send notifications to (ntfy, a Discord webhook, Telegram…). A provider
/// only knows how to talk to its service; whom to send to, when, how often to retry and when to give
/// up are decided once, in <see cref="ChannelDeliveryService"/>.
/// </summary>
public interface INotificationChannel
{
    /// <summary>The channel id this provider serves — one of <c>NotificationCatalog.Channels</c>.</summary>
    string Id { get; }

    /// <summary>
    /// Whether the admin has switched the channel on and given it what it needs. A channel that isn't
    /// available receives nothing, and what was waiting for it is dropped rather than piled up.
    /// </summary>
    bool IsAvailable(InstanceConfigStore config);

    /// <summary>Send one message. Never throws for an ordinary failure: say how it went in the result.</summary>
    Task<ChannelSendResult> SendAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct);
}

/// <summary>Setting keys for the chat channels. See <see cref="InstanceConfigStore"/>.</summary>
public static class ChannelKeys
{
    /// <summary>The admin's switch for a channel, off until they turn it on.</summary>
    public static string Enabled(string channel) => $"channels.{channel}.enabled";

    /// <summary>The Telegram bot's token (from BotFather). Sealed.</summary>
    public const string TelegramBotToken = "channels.telegram.botToken";
    /// <summary>The Discord bot's token, for direct messages. Sealed.</summary>
    public const string DiscordBotToken = "channels.discord.botToken";
    /// <summary>An optional ntfy access token. Sealed.</summary>
    public const string NtfyToken = "channels.ntfy.token";
}

/// <summary>The line a chat service gets for each kind of notification when the person keeps their privacy at "minimal".</summary>
public static class ChannelCopy
{
    /// <summary>Generic words for an event: no names, no titles, nothing from a note.</summary>
    public static string Headline(string eventId) => eventId switch
    {
        NotificationCatalog.Mention => "You were mentioned in a note",
        NotificationCatalog.Shared => "A note was shared with you",
        NotificationCatalog.AccessRequested => "Someone asked for access to a note",
        NotificationCatalog.AccessAnswered => "Your request for access was answered",
        NotificationCatalog.Comments => "There is a new comment for you",
        NotificationCatalog.JournalReminder => "Today's journal page is still blank",
        NotificationCatalog.ExportReady => "Your notes were exported",
        NotificationCatalog.BackupFailed => "Your backup needs attention",
        NotificationCatalog.BackupSucceeded => "Your backup finished",
        NotificationCatalog.ImportFinished => "Your import finished",
        NotificationCatalog.PasskeyAdded => "A passkey was added to your account",
        NotificationCatalog.PasskeyRemoved => "A passkey was removed from your account",
        NotificationCatalog.VaultPinChanged => "Your vault PIN was changed",
        NotificationCatalog.VaultPinLocked => "Your vault PIN was locked",
        NotificationCatalog.TotpChanged => "Your authenticator app was changed",
        NotificationCatalog.ApiKeyCreated => "A new API key was created",
        NotificationCatalog.AccountStatus => "Your account was changed by an administrator",
        NotificationCatalog.AdminAccountChanges => "An account on this Papyra was changed",
        NotificationCatalog.AdminJobFailed => "A background job failed on this Papyra",
        _ => NotificationCatalog.Find(eventId)?.Label ?? "Something happened in Papyra",
    };
}
