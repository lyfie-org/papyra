using LibGit2Sharp;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// The outcome of one sync pass. Status: disabled | clean | pushed | conflict | error.
public sealed record GitSyncResult(string Status, string? Detail);

// Native git backup/sync of the notes vault. On a ~30-minute loop (and on demand),
// if the vault is dirty it stages the notes, makes a timestamped commit, and pushes
// to a configured remote using a stored token. A push rejected as non-fast-forward
// (the remote moved on) is treated as a conflict: it is flagged in settings and
// broadcast over SignalR rather than force-pushed, so nothing is clobbered.
//
// Config + status live in the AppSettings table (git.* keys). Disabled (idle) until
// a remote URL is set. Git operations run off the timer thread.
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
            try { await SyncOnceAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogWarning(ex, "Git sync sweep failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    // One sync pass. Reads config, runs the git work off-thread, persists status, and
    // broadcasts a conflict if the push was rejected. Exposed for the manual-trigger
    // endpoint and tests.
    internal async Task<GitSyncResult> SyncOnceAsync(CancellationToken ct)
    {
        string? remoteUrl, branch, token;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            remoteUrl = await ReadSetting(db, "git.remoteUrl", ct);
            branch = await ReadSetting(db, "git.branch", ct);
            token = await ReadSetting(db, "git.token", ct);
        }

        if (string.IsNullOrWhiteSpace(remoteUrl)) return new GitSyncResult("disabled", null);
        branch = string.IsNullOrWhiteSpace(branch) ? "main" : branch.Trim();

        var usersDir = PapyraPaths.UsersDir(_config, _env.ContentRootPath);
        Directory.CreateDirectory(usersDir);
        EnsureGitignore(usersDir);

        GitSyncResult result;
        try
        {
            result = await Task.Run(() => RunSync(usersDir, remoteUrl!, branch!, token), ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Git sync failed");
            result = new GitSyncResult("error", ex.Message);
        }

        await PersistStatus(result, ct);
        if (result.Status == "conflict")
            await _hub.Clients.All.SendAsync("GitSyncConflict", new { detail = result.Detail }, ct);
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
        // Per-user hidden state (snapshots, order, categories, avatar) and the trash
        // bin are UI/disposable, never the synced note truth.
        File.WriteAllText(path, "**/.papyra/\n**/.trash/\n");
    }

    private async Task PersistStatus(GitSyncResult result, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await WriteSetting(db, "git.conflict", result.Status == "conflict" ? "true" : string.Empty, ct);
        await WriteSetting(db, "git.lastError", result.Status == "error" ? (result.Detail ?? "error") : string.Empty, ct);
        if (result.Status is "pushed" or "clean")
            await WriteSetting(db, "git.lastSyncUtc", DateTime.UtcNow.ToString("o"), ct);
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
