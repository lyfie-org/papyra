using System.Security.Cryptography;
using System.Text.Json;
using LibGit2Sharp;
using LibGit2Sharp.Handlers;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Security;

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
    /// <summary>"plain" (readable files) or "encrypted" (see <see cref="EncryptedGitCodec"/>).</summary>
    public static string Mode(string userId) => Prefix(userId) + "mode";
    /// <summary>The encrypted mode's data key, sealed with ASP.NET Data Protection.</summary>
    public static string DataKey(string userId) => Prefix(userId) + "dataKey";
    /// <summary>The <see cref="EncryptedGitHeader"/> (JSON) written into the repository.</summary>
    public static string Crypto(string userId) => Prefix(userId) + "crypto";

    /// <summary>
    /// The pre-per-user keys. Git sync used to be one instance-wide config that
    /// pushed every tenant's vault to a single remote; these are migrated onto the
    /// first admin's own account at boot and then removed.
    /// </summary>
    public static readonly string[] LegacyKeys =
        ["git.remoteUrl", "git.branch", "git.token", "git.conflict", "git.lastSyncUtc", "git.lastError"];
}

// Native git backup of a user's own vault. On a ~30-minute loop (and on demand)
// it rebuilds the backup, makes a timestamped commit if anything changed, and
// pushes to that user's configured remote using their stored token. A push
// rejected as non-fast-forward (the remote moved on) is treated as a conflict: it
// is flagged and broadcast over SignalR rather than force-pushed, so nothing is
// clobbered.
//
// One repository per user. Backing up your notes is a personal decision about
// your own data, so the remote, the token and the schedule all belong to the
// account that owns them — and an admin has no route through Papyra to another
// user's vault.
//
// What is pushed is not the live user directory but a mirror of it in the backup
// layout (see BackupLayout): notes/, todos/, vault/, media/{images,documents,…}/
// and settings/ — or, in encrypted mode, the same folders holding sealed files
// (see EncryptedGitCodec). The mirror is its own repository under
// users/{userId}/.papyra/git-mirror, regenerated from the vault on each pass.
//
// Config + status live in the AppSettings table under git.u{userId}.* keys.
// Disabled (idle) for a user until they set a remote URL.
public sealed class GitSyncService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);

    internal static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly IHubContext<NotesHub> _hub;
    private readonly ILogger<GitSyncService> _logger;
    private readonly EmailSender? _email;
    private readonly IDataProtector _keyProtector;
    private readonly BackupLayout _layout;
    // One pass at a time: the half-hourly sweep and a "Back up now" click must not
    // both rewrite the same mirror.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public GitSyncService(
        IServiceScopeFactory scopes,
        IConfiguration config,
        IHostEnvironment env,
        IHubContext<NotesHub> hub,
        ILogger<GitSyncService> logger,
        IDataProtectionProvider dataProtection,
        BackupLayout layout,
        EmailSender? email = null)
    {
        _scopes = scopes;
        _config = config;
        _env = env;
        _hub = hub;
        _logger = logger;
        _email = email;
        _keyProtector = dataProtection.CreateProtector("Papyra.GitBackupKey.v1");
        _layout = layout;
    }

    public string ProtectKey(byte[] dataKey) => _keyProtector.Protect(Convert.ToBase64String(dataKey));
    public byte[] UnprotectKey(string sealedKey) => Convert.FromBase64String(_keyProtector.Unprotect(sealedKey));

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

    // One sync pass for one user. Reads their config, builds the backup, runs the
    // git work off-thread, persists status, and broadcasts a conflict if the push
    // was rejected. Exposed for the manual-trigger endpoint and tests.
    internal async Task<GitSyncResult> SyncOnceAsync(string userId, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try { return await SyncCoreAsync(userId, ct); }
        finally { _gate.Release(); }
    }

    private async Task<GitSyncResult> SyncCoreAsync(string userId, CancellationToken ct)
    {
        var stage = Path.Combine(Path.GetTempPath(), $"papyra-git-{Guid.NewGuid():N}");
        var mirror = PapyraPaths.UserGitMirrorDir(_config, _env.ContentRootPath, userId);
        GitSyncResult result;
        try
        {
            string? remoteUrl, branch, token, mode, sealedKey, crypto;
            var plain = Path.Combine(stage, "plain");
            using (var scope = _scopes.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                remoteUrl = await ReadSetting(db, GitKeys.RemoteUrl(userId), ct);
                if (string.IsNullOrWhiteSpace(remoteUrl)) return new GitSyncResult("disabled", null);
                if (!int.TryParse(userId, out var uid) || await db.Users.FindAsync([uid], ct) is not { } user)
                    return new GitSyncResult("disabled", null);

                branch = await ReadSetting(db, GitKeys.Branch(userId), ct);
                token = await ReadSetting(db, GitKeys.Token(userId), ct);
                mode = await ReadSetting(db, GitKeys.Mode(userId), ct);
                sealedKey = await ReadSetting(db, GitKeys.DataKey(userId), ct);
                crypto = await ReadSetting(db, GitKeys.Crypto(userId), ct);

                // The backup, in its published shape, built fresh from the vault.
                await _layout.BuildAsync(user, db, plain, ct);
            }
            branch = string.IsNullOrWhiteSpace(branch) ? "main" : branch.Trim();

            var content = plain;
            if (mode == "encrypted")
            {
                if (string.IsNullOrEmpty(sealedKey) || string.IsNullOrEmpty(crypto))
                    return await FinishAsync(userId, new GitSyncResult("error",
                        "The encrypted backup has lost its key. Switch encryption off and on again in Settings → Backup."), ct);
                var header = JsonSerializer.Deserialize<EncryptedGitHeader>(crypto, JsonOpts)!;
                var key = UnprotectKey(sealedKey);
                try
                {
                    var sealedRoot = Path.Combine(stage, "sealed");
                    Directory.CreateDirectory(sealedRoot);
                    EncryptedGitCodec.EncryptTree(plain, sealedRoot, key);
                    await File.WriteAllTextAsync(Path.Combine(sealedRoot, BackupManifest.FileName), JsonSerializer.Serialize(
                        new BackupManifest(BackupManifest.FormatName, BackupManifest.CurrentVersion, true, Crypto: header), JsonOpts), ct);
                    await File.WriteAllTextAsync(Path.Combine(sealedRoot, "README.md"), BackupLayout.Readme(encrypted: true), ct);
                    content = sealedRoot;
                }
                finally { CryptographicOperations.ZeroMemory(key); }
            }

            result = await Task.Run(() => RunSync(mirror, content, remoteUrl!, branch, token), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Git sync failed for user {User}", userId);
            result = new GitSyncResult("error", ex.Message);
        }
        finally
        {
            try { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
            catch (IOException) { /* a temp dir; the OS reclaims it */ }
        }

        return await FinishAsync(userId, result, ct);
    }

    private async Task<GitSyncResult> FinishAsync(string userId, GitSyncResult result, CancellationToken ct)
    {
        await PersistStatus(userId, result, ct);
        if (result.Status == "conflict")
        {
            // Only the owner needs to know their own backup diverged.
            await _hub.Clients.User(userId).SendAsync("GitSyncConflict", new { detail = result.Detail }, ct);
        }
        return result;
    }

    /// <summary>
    /// Check a remote and token before saving them — the setup guide's "Test"
    /// step. Lists the remote's branches without cloning anything. Returns a
    /// plain-language problem, or null with the branches it found (none for a
    /// brand-new, empty repository, which is exactly what setup expects).
    /// </summary>
    public static (string? Problem, IReadOnlyList<string> Branches) Probe(string remoteUrl, string? token)
    {
        try
        {
            var refs = Repository.ListRemoteReferences(remoteUrl, (_, _, _) =>
                new UsernamePasswordCredentials { Username = "x-access-token", Password = token ?? string.Empty });
            var branches = refs
                .Where(r => r.CanonicalName.StartsWith("refs/heads/", StringComparison.Ordinal))
                .Select(r => r.CanonicalName["refs/heads/".Length..])
                .ToList();
            return (null, branches);
        }
        catch (LibGit2SharpException ex)
        {
            var m = ex.Message;
            if (m.Contains("401") || m.Contains("403") || m.Contains("authentication", StringComparison.OrdinalIgnoreCase)
                || m.Contains("credentials", StringComparison.OrdinalIgnoreCase))
                return ("The repository turned the access token down. Check it was copied whole, hasn't expired, "
                    + "and is allowed to write to this repository.", []);
            if (m.Contains("404") || m.Contains("not found", StringComparison.OrdinalIgnoreCase))
                return ("No repository at that address — or the token can't see it. Check the address, and that "
                    + "the token has access to this repository.", []);
            if (m.Contains("resolve", StringComparison.OrdinalIgnoreCase) || m.Contains("connect", StringComparison.OrdinalIgnoreCase))
                return ("This server couldn't reach that address. Check it, and that the server can get to the internet.", []);
            return ($"The repository didn't answer as expected: {m}", []);
        }
    }

    /// <summary>
    /// Clone a backup repository into <paramref name="dest"/> for a restore.
    /// Returns a plain-language problem, or null on success.
    /// </summary>
    public static string? CloneForRestore(string remoteUrl, string branch, string? token, string dest)
    {
        var (problem, branches) = Probe(remoteUrl, token);
        if (problem is not null) return problem;
        if (branches.Count == 0) return "That repository is empty — there is no backup in it yet.";
        if (!branches.Contains(branch))
            return $"There is no branch called \"{branch}\" in that repository. It has: {string.Join(", ", branches.Take(8))}.";
        try
        {
            var options = new CloneOptions { BranchName = branch, Checkout = true };
            options.FetchOptions.CredentialsProvider = (_, _, _) =>
                new UsernamePasswordCredentials { Username = "x-access-token", Password = token ?? string.Empty };
            Repository.Clone(remoteUrl, dest, options);
            return null;
        }
        catch (LibGit2SharpException ex)
        {
            return $"The repository couldn't be downloaded: {ex.Message}";
        }
    }

    private static GitSyncResult RunSync(string dir, string content, string remoteUrl, string branch, string? token)
    {
        Directory.CreateDirectory(dir);
        if (!Repository.IsValid(dir))
        {
            Repository.Init(dir);
            using var fresh = new Repository(dir);
            fresh.Refs.UpdateTarget("HEAD", $"refs/heads/{branch}"); // first commit lands on the configured branch
        }

        using var repo = new Repository(dir);

        if (repo.Network.Remotes["origin"] is null) repo.Network.Remotes.Add("origin", remoteUrl);
        else repo.Network.Remotes.Update("origin", r => r.Url = remoteUrl);

        CredentialsHandler? credentials = string.IsNullOrWhiteSpace(token) ? null : (_, _, _) =>
            new UsernamePasswordCredentials { Username = "x-access-token", Password = token };

        // A brand-new mirror pointed at a repository that already has history —
        // the backup an older Papyra wrote, or the one this account was restored
        // from — continues that history instead of being refused as unrelated.
        if (repo.Head.Tip is null)
        {
            var (_, branches) = Probe(remoteUrl, token);
            if (branches.Contains(branch))
            {
                var fetch = new FetchOptions();
                if (credentials is not null) fetch.CredentialsProvider = credentials;
                Commands.Fetch(repo, "origin", [$"+refs/heads/{branch}:refs/remotes/origin/{branch}"], fetch, null);
                if (repo.Branches[$"origin/{branch}"]?.Tip is { } remoteTip)
                {
                    repo.Refs.Add($"refs/heads/{branch}", remoteTip.Id, allowOverwrite: true);
                    repo.Refs.UpdateTarget("HEAD", $"refs/heads/{branch}");
                    repo.Reset(ResetMode.Mixed, remoteTip);
                }
            }
        }

        // Replace the working tree with the freshly built backup. A deleted note
        // disappears from the tree, and staging records the deletion.
        foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
        {
            if (Path.GetFileName(entry) == ".git") continue;
            if (Directory.Exists(entry)) Directory.Delete(entry, recursive: true);
            else File.Delete(entry);
        }
        foreach (var file in Directory.EnumerateFiles(content, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dir, Path.GetRelativePath(content, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }

        Commands.Stage(repo, "*");
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
        if (credentials is not null) pushOptions.CredentialsProvider = credentials;

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

    private async Task PersistStatus(string userId, GitSyncResult result, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        // Whether it was already failing, so a broken backup is reported once when
        // it breaks — not every half hour until someone fixes it.
        var wasFailing = !string.IsNullOrEmpty(await ReadSetting(db, GitKeys.LastError(userId), ct))
            || await ReadSetting(db, GitKeys.Conflict(userId), ct) == "true";
        await WriteSetting(db, GitKeys.Conflict(userId), result.Status == "conflict" ? "true" : string.Empty, ct);
        await WriteSetting(db, GitKeys.LastError(userId), result.Status == "error" ? (result.Detail ?? "error") : string.Empty, ct);
        if (result.Status is "pushed" or "clean")
            await WriteSetting(db, GitKeys.LastSyncUtc(userId), DateTime.UtcNow.ToString("o"), ct);
        await db.SaveChangesAsync(ct);

        if (_email is null || !int.TryParse(userId, out var uid)) return;
        if (await db.Users.FindAsync([uid], ct) is not { } user) return;
        var failing = result.Status is "error" or "conflict";
        if (failing && !wasFailing)
        {
            await _email.NotifyAsync(user, NotificationCatalog.BackupFailed,
                result.Status == "conflict" ? "Your Papyra backup needs attention" : "Your Papyra backup failed",
                result.Status == "conflict"
                    ? "The git repository your notes back up to has changes Papyra doesn't have, so it stopped "
                      + "rather than overwrite them. Nothing was lost on either side.\n\n"
                      + "Open Settings → Backup in Papyra to see what to do."
                    : "Papyra couldn't push your notes to your git repository. It will keep trying every half hour, "
                      + "but won't email again until it has worked once.\n\n"
                      + "Open Settings → Backup in Papyra to check the repository address and access token.",
                [new("What happened", Short(result.Detail ?? result.Status))], ct);
        }
        else if (result.Status == "pushed")
        {
            // Recovery is news to whoever heard about the failure.
            await _email.NotifyAsync(user, wasFailing ? NotificationCatalog.BackupFailed : NotificationCatalog.BackupSucceeded,
                wasFailing ? "Your Papyra backup is working again" : "Your notes were backed up",
                wasFailing
                    ? "Your git backup pushed successfully after failing before. Everything is up to date."
                    : "Papyra pushed your latest changes to your git repository.",
                [new("When", SignInNotices.When(user, DateTime.UtcNow))], ct);
        }
    }

    private static string Short(string text) => text.Length > 300 ? text[..300] + "…" : text;

    private static async Task<string?> ReadSetting(AppDbContext db, string key, CancellationToken ct) =>
        (await db.Settings.FirstOrDefaultAsync(s => s.Key == key, ct))?.Value;

    private static async Task WriteSetting(AppDbContext db, string key, string value, CancellationToken ct)
    {
        var row = await db.Settings.FindAsync([key], ct);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
    }
}
