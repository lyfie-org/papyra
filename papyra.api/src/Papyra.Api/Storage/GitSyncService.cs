using LibGit2Sharp;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// The outcome of one sync pass. Status: disabled | clean | pushed | conflict | error.
public sealed record GitSyncResult(string Status, string? Detail);

/// <summary>Per-user git settings. Keys are namespaced by owner — see <see cref="GitSyncService"/>.</summary>
public static class GitKeys
{
    /// <summary>The settings prefix owning <paramref name="userId"/>'s git config.</summary>
    public static string Prefix(string userId) => $"git.u{userId}.";

    public static string RemoteUrl(string userId) => Prefix(userId) + "remoteUrl";
    public static string Branch(string userId) => Prefix(userId) + "branch";
    public static string Token(string userId) => Prefix(userId) + "token";
    public static string Conflict(string userId) => Prefix(userId) + "conflict";
    public static string LastSyncUtc(string userId) => Prefix(userId) + "lastSyncUtc";
    public static string LastError(string userId) => Prefix(userId) + "lastError";

    /// <summary>
    /// The pre-per-user keys. Git sync used to be one instance-wide config that
    /// pushed every tenant's vault to a single remote; these are migrated onto the
    /// first admin's own account at boot and then removed.
    /// </summary>
    public static readonly string[] LegacyKeys =
        ["git.remoteUrl", "git.branch", "git.token", "git.conflict", "git.lastSyncUtc", "git.lastError"];
}

// Native git backup of a user's own vault. On a ~30-minute loop (and on demand),
// if the vault is dirty it stages the notes, makes a timestamped commit, and pushes
// to that user's configured remote using their stored token. A push rejected as
// non-fast-forward (the remote moved on) is treated as a conflict: it is flagged
// and broadcast over SignalR rather than force-pushed, so nothing is clobbered.
//
// One repository per user, rooted at users/{userId}/. This is the whole point of
// the design: the previous version initialised a single repo over the *users*
// directory, so any admin who configured a remote pushed every tenant's notes to
// it. Backing up your notes is a personal decision about your own data, so the
// remote, the token and the schedule all belong to the account that owns them —
// and an admin has no route through Papyra to another user's vault.
//
// Config + status live in the AppSettings table under git.u{userId}.* keys.
// Disabled (idle) for a user until they set a remote URL.
public sealed class GitSyncService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly IHubContext<NotesHub> _hub;
    private readonly ILogger<GitSyncService> _logger;

    public GitSyncService(
        IServiceScopeFactory scopes,
        IConfiguration config,
        IHostEnvironment env,
        IHubContext<NotesHub> hub,
        ILogger<GitSyncService> logger)
    {
        _scopes = scopes;
        _config = config;
        _env = env;
        _hub = hub;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(45), stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Interval);
        do
        {
            try { await SyncAllAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogWarning(ex, "Git sync sweep failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    // Sweep every user who has configured a remote. One user's failure must not
    // stop the next one's backup, so each is isolated.
    internal async Task SyncAllAsync(CancellationToken ct)
    {
        foreach (var userId in await ConfiguredUsersAsync(ct))
        {
            try { await SyncOnceAsync(userId, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Git sync failed for user {User}", userId); }
        }
    }

    /// <summary>Users with a non-blank remote URL, derived from the settings keys.</summary>
    internal async Task<IReadOnlyList<string>> ConfiguredUsersAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var rows = await db.Settings
            .Where(s => s.Key.StartsWith("git.u") && s.Key.EndsWith(".remoteUrl"))
            .ToListAsync(ct);

        return rows
            .Where(r => !string.IsNullOrWhiteSpace(r.Value))
            .Select(r => r.Key["git.u".Length..^".remoteUrl".Length])
            .Where(u => u.Length > 0)
            .ToList();
    }

    // One sync pass for one user. Reads their config, runs the git work off-thread,
    // persists status, and broadcasts a conflict if the push was rejected. Exposed
    // for the manual-trigger endpoint and tests.
    internal async Task<GitSyncResult> SyncOnceAsync(string userId, CancellationToken ct)
    {
        string? remoteUrl, branch, token;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            remoteUrl = await ReadSetting(db, GitKeys.RemoteUrl(userId), ct);
            branch = await ReadSetting(db, GitKeys.Branch(userId), ct);
            token = await ReadSetting(db, GitKeys.Token(userId), ct);
        }

        if (string.IsNullOrWhiteSpace(remoteUrl)) return new GitSyncResult("disabled", null);
        branch = string.IsNullOrWhiteSpace(branch) ? "main" : branch.Trim();

        // The user's own directory — not the users root. Their notes, their media,
        // nobody else's.
        var userDir = Path.Combine(PapyraPaths.UsersDir(_config, _env.ContentRootPath), userId);
        Directory.CreateDirectory(userDir);
        EnsureGitignore(userDir);

        GitSyncResult result;
        try
        {
            result = await Task.Run(() => RunSync(userDir, remoteUrl!, branch!, token), ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Git sync failed for user {User}", userId);
            result = new GitSyncResult("error", ex.Message);
        }

        await PersistStatus(userId, result, ct);
        if (result.Status == "conflict")
        {
            // Only the owner needs to know their own backup diverged.
            await _hub.Clients.User(userId).SendAsync("GitSyncConflict", new { detail = result.Detail }, ct);
        }
        return result;
    }

    private GitSyncResult RunSync(string dir, string remoteUrl, string branch, string? token)
    {
        if (!Repository.IsValid(dir))
        {
            Repository.Init(dir);
            using var fresh = new Repository(dir);
            fresh.Refs.UpdateTarget("HEAD", $"refs/heads/{branch}"); // first commit lands on the configured branch
        }

        using var repo = new Repository(dir);

        if (repo.Network.Remotes["origin"] is null) repo.Network.Remotes.Add("origin", remoteUrl);
        else repo.Network.Remotes.Update("origin", r => r.Url = remoteUrl);

        Commands.Stage(repo, "*"); // .gitignore keeps .papyra/.trash out
        var committed = false;
        if (repo.RetrieveStatus().IsDirty)
        {
            var sig = new Signature("Papyra", "papyra@localhost", DateTimeOffset.Now);
            repo.Commit($"Papyra sync {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss} UTC", sig, sig);
            committed = true;
        }

        if (repo.Head.Tip is null) return new GitSyncResult("clean", null); // nothing committed yet

        var rejected = false;
        string? rejectMsg = null;
        var pushOptions = new PushOptions
        {
            OnPushStatusError = err => { rejected = true; rejectMsg = err.Message; },
        };
        if (!string.IsNullOrWhiteSpace(token))
            pushOptions.CredentialsProvider = (_, _, _) =>
                new UsernamePasswordCredentials { Username = "x-access-token", Password = token };

        var localBranch = repo.Head.FriendlyName;
        try
        {
            repo.Network.Push(repo.Network.Remotes["origin"], $"refs/heads/{localBranch}:refs/heads/{branch}", pushOptions);
        }
        catch (NonFastForwardException ex)
        {
            return new GitSyncResult("conflict", ex.Message);
        }
        catch (LibGit2SharpException ex) when (
            ex.Message.Contains("fast-forward", StringComparison.OrdinalIgnoreCase) ||
            ex.Message.Contains("cannot push", StringComparison.OrdinalIgnoreCase))
        {
            return new GitSyncResult("conflict", ex.Message);
        }

        if (rejected) return new GitSyncResult("conflict", rejectMsg);
        return new GitSyncResult(committed ? "pushed" : "clean", null);
    }

    private static void EnsureGitignore(string dir)
    {
        var path = Path.Combine(dir, ".gitignore");
        if (File.Exists(path)) return;
        // Papyra-owned state (snapshots, order, categories, avatar) and the trash
        // bin are UI/disposable, never the synced note truth.
        File.WriteAllText(path, ".papyra/\n.trash/\n");
    }

    private async Task PersistStatus(string userId, GitSyncResult result, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await WriteSetting(db, GitKeys.Conflict(userId), result.Status == "conflict" ? "true" : string.Empty, ct);
        await WriteSetting(db, GitKeys.LastError(userId), result.Status == "error" ? (result.Detail ?? "error") : string.Empty, ct);
        if (result.Status is "pushed" or "clean")
            await WriteSetting(db, GitKeys.LastSyncUtc(userId), DateTime.UtcNow.ToString("o"), ct);
        await db.SaveChangesAsync(ct);
    }

    private static async Task<string?> ReadSetting(AppDbContext db, string key, CancellationToken ct) =>
        (await db.Settings.FirstOrDefaultAsync(s => s.Key == key, ct))?.Value;

    private static async Task WriteSetting(AppDbContext db, string key, string value, CancellationToken ct)
    {
        var row = await db.Settings.FindAsync([key], ct);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
    }
}
