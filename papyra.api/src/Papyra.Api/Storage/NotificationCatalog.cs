using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// One kind of thing Papyra can tell a person about. The id is stable — it is
/// what preferences are stored under — so rename the label freely, never the id.
/// </summary>
/// <param name="Critical">
/// Always delivered and shown switched-on-but-locked. Reserved for mail whose
/// absence is itself the danger: being told your password changed is how you
/// find out it wasn't you.
/// </param>
/// <param name="AdminOnly">Only offered to (and only ever sent to) administrators.</param>
public sealed record NotificationEvent(
    string Id, string Group, string Label, string Description,
    bool Critical = false, bool DefaultOn = true, bool AdminOnly = false);

/// <summary>
/// Every notification Papyra sends, in the order the Settings screen lists them.
///
/// Email is the only channel today, but preferences are stored per channel
/// (<see cref="NotificationPrefs"/>) so push to the mobile app can arrive as a
/// second column without migrating anyone's choices.
/// </summary>
public static class NotificationCatalog
{
    public const string Email = "email";
    public static readonly string[] Channels = [Email];

    // Security — the account itself. All critical.
    public const string NewSignIn = "security.new_sign_in";
    public const string PasswordChanged = "security.password_changed";
    public const string PasswordReset = "security.password_reset";
    public const string VerificationCode = "security.verification_code";
    public const string PasskeyAdded = "security.passkey_added";
    public const string PasskeyRemoved = "security.passkey_removed";
    public const string VaultPinChanged = "security.vault_pin_changed";
    public const string VaultPinLocked = "security.vault_pin_locked";
    public const string ApiKeyCreated = "security.api_key_created";
    public const string EmailChanged = "security.email_changed";
    public const string AccountStatus = "account.status";
    public const string AccountDeletion = "account.deletion";

    // Your data.
    public const string ExportReady = "data.export";
    public const string BackupSucceeded = "data.backup_succeeded";
    public const string BackupFailed = "data.backup_failed";
    public const string ImportFinished = "data.import_finished";

    // Other people.
    public const string Mention = "collab.mention";
    public const string Shared = "collab.shared";
    public const string AccessRequested = "collab.access_requested";
    public const string AccessAnswered = "collab.access_answered";

    // Running the instance.
    public const string AdminAccountChanges = "admin.accounts";
    public const string AdminJobFailed = "admin.job_failed";

    public static readonly IReadOnlyList<NotificationEvent> Events =
    [
        new(NewSignIn, "security", "New sign-in",
            "Someone signed in to your account from a browser or device it hasn't seen before.", Critical: true),
        new(PasswordChanged, "security", "Password changed",
            "Your password was changed or reset.", Critical: true),
        new(PasswordReset, "security", "Password reset links",
            "A link to set a new password, when you or an administrator ask for one.", Critical: true),
        new(VerificationCode, "security", "Verification codes",
            "One-time codes Papyra asks for before something that can't be undone.", Critical: true),
        new(EmailChanged, "security", "Email address changed",
            "Sent to your old address when the address on your account changes.", Critical: true),
        new(PasskeyAdded, "security", "Passkey added",
            "A device was registered to sign in and open your vault with biometrics.", Critical: true),
        new(PasskeyRemoved, "security", "Passkey removed",
            "A registered device can no longer sign in or open your vault.", Critical: true),
        new(VaultPinChanged, "security", "Vault PIN set or changed",
            "The PIN that opens your locked notes was set, changed or reset.", Critical: true),
        new(VaultPinLocked, "security", "Vault PIN locked",
            "Too many wrong PIN tries paused or switched off your vault PIN.", Critical: true),
        new(ApiKeyCreated, "security", "API key created",
            "A new key that can read and write your notes from scripts was made.", Critical: true),
        new(AccountStatus, "security", "Account changes by an administrator",
            "Your account was disabled or re-enabled, or your role changed.", Critical: true),
        new(AccountDeletion, "security", "Account deletion",
            "Your account was scheduled for deletion, the deletion was cancelled, or it's about to happen.", Critical: true),

        new(ExportReady, "data", "Notes exported",
            "A copy of all your notes was downloaded — so you'd know if it wasn't you.", Critical: true),
        new(BackupFailed, "data", "Backup failed",
            "Your git backup stopped working, or the repository diverged. Sent once, not on every retry."),
        new(BackupSucceeded, "data", "Backup succeeded",
            "Each time your git backup pushes new changes. Can be a lot of mail on a busy day.", DefaultOn: false),
        new(ImportFinished, "data", "Import finished",
            "A large import you started has finished, with how many notes came in."),

        new(Mention, "collab", "Mentions",
            "Someone @mentions you in one of their notes."),
        new(Shared, "collab", "Shared with you",
            "Someone shares a note with you, or gives you edit access."),
        new(AccessRequested, "collab", "Access requests",
            "Someone asks to see a note of yours they were mentioned in."),
        new(AccessAnswered, "collab", "Answers to your requests",
            "Your request to see someone's note was approved or declined."),

        new(AdminAccountChanges, "admin", "Account changes",
            "Another administrator adds, removes, disables or changes the role of an account.", AdminOnly: true),
        new(AdminJobFailed, "admin", "Background job failed",
            "A housekeeping job — emptying the trash, search rebuilds — failed on this server.", AdminOnly: true),
    ];

    public static readonly IReadOnlyDictionary<string, string> Groups = new Dictionary<string, string>
    {
        ["security"] = "Security & account",
        ["data"] = "Your notes & backups",
        ["collab"] = "Other people",
        ["admin"] = "Running this Papyra",
    };

    private static readonly Dictionary<string, NotificationEvent> ById = Events.ToDictionary(e => e.Id);

    public static NotificationEvent? Find(string id) => ById.GetValueOrDefault(id);
}

/// <summary>
/// A person's notification switches, stored on their row as
/// <c>{"email": {"collab.mention": false}}</c> — only what differs from the
/// default is written, so a new event gets its default for everyone at once.
/// </summary>
public static class NotificationPrefs
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static Dictionary<string, Dictionary<string, bool>> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, bool>>>(json, Json) ?? new();
        }
        catch (JsonException)
        {
            // A damaged column must not take mail down with it: fall back to defaults.
            return new();
        }
    }

    /// <summary>Whether <paramref name="user"/> gets <paramref name="eventId"/> on <paramref name="channel"/>.</summary>
    public static bool Wants(User user, string eventId, string channel = NotificationCatalog.Email)
    {
        var ev = NotificationCatalog.Find(eventId);
        if (ev is null) return false;
        if (ev.AdminOnly && user.Role != "Admin") return false;
        if (ev.Critical) return true;

        var prefs = Parse(user.NotificationPrefs);
        if (prefs.TryGetValue(channel, out var ch) && ch.TryGetValue(eventId, out var on)) return on;

        // The two switches that predate the catalog keep their answer until the
        // person touches the new list.
        return eventId switch
        {
            NotificationCatalog.Mention => user.NotifyOnMention,
            NotificationCatalog.Shared or NotificationCatalog.AccessRequested or NotificationCatalog.AccessAnswered
                => user.NotifyOnShare,
            _ => ev.DefaultOn,
        };
    }

    /// <summary>
    /// Record one switch. Returns false for an unknown or critical event (which
    /// cannot be switched off) so the endpoint can say so.
    /// </summary>
    public static bool Set(User user, string eventId, bool on, string channel = NotificationCatalog.Email)
    {
        var ev = NotificationCatalog.Find(eventId);
        if (ev is null || ev.Critical || !NotificationCatalog.Channels.Contains(channel)) return false;
        if (ev.AdminOnly && user.Role != "Admin") return false;

        var prefs = Parse(user.NotificationPrefs);
        if (!prefs.TryGetValue(channel, out var ch)) prefs[channel] = ch = new();
        ch[eventId] = on;
        user.NotificationPrefs = JsonSerializer.Serialize(prefs, Json);

        // Keep the legacy columns honest for anything still reading them.
        if (eventId == NotificationCatalog.Mention) user.NotifyOnMention = on;
        if (eventId == NotificationCatalog.Shared) user.NotifyOnShare = on;
        return true;
    }
}
