using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// Deleting an account, the slow and deliberate way.
///
/// A request (password + vault PIN/biometric + an emailed code, with a password
/// that is over a day old) only <em>schedules</em> the deletion, a week out.
/// Until then the account can sign in for one thing — cancelling — and gets an
/// email every day saying when everything goes. When the week is up this purges
/// it: every file under the tenant's folder (notes, attachments, history,
/// avatar), every database row that belongs to or points at the account, the
/// search index, and finally the user row itself.
/// </summary>
public sealed class AccountDeletion
{
    public static readonly TimeSpan GracePeriod = TimeSpan.FromDays(7);
    public static readonly TimeSpan MinPasswordAge = TimeSpan.FromHours(24);

    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly VaultObserver _observer;
    private readonly UnlockTokenStore _unlockTokens;
    private readonly EmailSender _email;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly ILogger<AccountDeletion> _logger;

    public AccountDeletion(
        IServiceScopeFactory scopes, VaultState state, SearchIndexService search, VaultObserver observer,
        UnlockTokenStore unlockTokens, EmailSender email, IConfiguration config, IHostEnvironment env,
        ILogger<AccountDeletion> logger)
    {
        _scopes = scopes;
        _state = state;
        _search = search;
        _observer = observer;
        _unlockTokens = unlockTokens;
        _email = email;
        _config = config;
        _env = env;
        _logger = logger;
    }

    /// <summary>Purge what's due and send today's reminders. Returns (purged, reminded).</summary>
    public async Task<(int Purged, int Reminded)> SweepAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = DateTime.UtcNow;
        var scheduled = await db.Users.Where(u => u.DeletionScheduledUtc != null).ToListAsync(ct);
        int purged = 0, reminded = 0;

        foreach (var user in scheduled)
        {
            var due = DateTime.SpecifyKind(user.DeletionScheduledUtc!.Value, DateTimeKind.Utc);
            if (due <= now)
            {
                var (address, name) = (user.Email, user.Username);
                await PurgeAsync(db, user, ct);
                purged++;
                if (!string.IsNullOrWhiteSpace(address))
                    await _email.SendAsync(address, "Your Papyra account has been deleted",
                        $"The account @{name} and everything in it — notes, attachments, history and settings — "
                        + "has now been permanently deleted, as you asked a week ago.\n\n"
                        + "Nothing of it remains on the server. Thank you for using Papyra.",
                        ct);
                continue;
            }

            // Once a day until then.
            if (user.DeletionReminderUtc is { } last && now - DateTime.SpecifyKind(last, DateTimeKind.Utc) < TimeSpan.FromHours(23))
                continue;
            if (!string.IsNullOrWhiteSpace(user.Email))
            {
                var left = due - now;
                var days = Math.Max(1, (int)Math.Ceiling(left.TotalDays));
                await _email.SendAsync(user.Email,
                    $"Your Papyra account will be deleted in {days} day{(days == 1 ? "" : "s")}",
                    $"You asked for the account @{user.Username} to be deleted. Everything in it — every note, "
                    + "attachment and version — will be permanently erased on the date below.\n\n"
                    + "Changed your mind? Sign in to Papyra and choose “Keep my account” before then.",
                    [new EmailDetail("Deletion date", $"{due:dddd d MMMM yyyy, HH:mm} UTC"), new EmailDetail("Account", $"@{user.Username}")],
                    ct);
            }
            user.DeletionReminderUtc = now;
            reminded++;
        }
        await db.SaveChangesAsync(ct);
        return (purged, reminded);
    }

    /// <summary>Erase one account now: files, rows, index, user.</summary>
    public async Task PurgeAsync(AppDbContext db, User user, CancellationToken ct)
    {
        var id = user.Id;
        var uid = id.ToString();

        _observer.UnwatchUser(uid);
        _unlockTokens.RevokeUser(uid);

        db.ApiKeys.RemoveRange(db.ApiKeys.Where(k => k.UserId == id));
        db.Shares.RemoveRange(db.Shares.Where(s => s.OwnerId == id || s.GranteeUserId == id));
        db.AccessRequests.RemoveRange(db.AccessRequests.Where(r => r.OwnerId == id || r.RequesterUserId == id));
        db.Notifications.RemoveRange(db.Notifications.Where(n => n.UserId == id || n.ActorUserId == id || n.OwnerId == id));
        db.BlockGrants.RemoveRange(db.BlockGrants.Where(g => g.SourceOwnerId == id || g.GranteeUserId == id));
        db.WebAuthnCredentials.RemoveRange(db.WebAuthnCredentials.Where(c => c.UserId == id));
        db.Webhooks.RemoveRange(db.Webhooks.Where(w => w.UserId == id));
        db.SmartCollections.RemoveRange(db.SmartCollections.Where(c => c.UserId == id));
        db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.UserId == id));
        var sessions = db.ChatSessions.Where(c => c.UserId == id).Select(c => c.Id);
        db.ChatMessages.RemoveRange(db.ChatMessages.Where(m => sessions.Contains(m.SessionId)));
        db.ChatSessions.RemoveRange(db.ChatSessions.Where(c => c.UserId == id));
        db.NoteCache.RemoveRange(db.NoteCache.Where(r => r.UserId == uid));
        db.NoteEmbeddings.RemoveRange(db.NoteEmbeddings.Where(e => e.UserId == uid));
        db.Users.Remove(user);
        await db.SaveChangesAsync(ct);

        _search.RebuildUser(uid, []);
        _state.RemoveUser(uid);

        var root = Path.Combine(PapyraPaths.UsersDir(_config, _env.ContentRootPath), uid);
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (Exception ex)
        {
            // The account is gone either way; say loudly that files were left.
            _logger.LogError(ex, "Account {User} deleted but its folder {Root} could not be removed", uid, root);
        }
        _logger.LogWarning("Account {User} permanently deleted at the owner's request", uid);
    }
}

/// <summary>Hourly: purge accounts whose week is up, and send each pending one its daily reminder.</summary>
public sealed class AccountDeletionJob : PeriodicJob
{
    private readonly AccountDeletion _deletion;

    public AccountDeletionJob(AccountDeletion deletion, JobRegistry registry) : base(registry) => _deletion = deletion;

    protected override string JobId => "account-deletion";
    protected override string JobName => "Delete accounts that asked to go";
    protected override string JobDescription =>
        "Permanently erases an account a week after its owner asked for that, and emails them a reminder each "
        + "day until then. Nothing happens to accounts that haven't asked.";
    protected override TimeSpan Interval => TimeSpan.FromHours(1);
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(1);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var (purged, reminded) = await _deletion.SweepAsync(ct);
        if (purged == 0 && reminded == 0) return null;
        return $"{purged} deleted, {reminded} reminded";
    }
}
