using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;

namespace Papyra.Api.Storage;

public sealed class VaultObserverOptions
{
    // Per-tenant root: each user's vault lives at {UsersDir}/{userId}/notes/.
    public required string UsersDir { get; init; }

    // Per-path debounce window. One logical change can fire many OS events; we
    // collapse a quiet-for-DebounceMs burst into a single update.
    public int DebounceMs { get; init; } = 200;

    // Absolute notes vault for one tenant.
    public string UserNotesDir(string userId) => Path.Combine(UsersDir, userId, "notes");
}

// Reactive file observer: watches each tenant's notes dir with its own
// FileSystemWatcher (never a single global /data watcher, or tenants would bleed)
// and keeps VaultState in sync with the .md files on disk. Three guards stop it
// melting down under sync tools and its own writes:
//   • Write-Ring — skip the echo of Papyra's own atomic writes (loop prevention).
//   • Debouncer  — collapse a storm of micro-events per path into one update.
//   • Backoff    — MarkdownStorageService.ReadAsync retries lock-held reads.
// Registered as a singleton + hosted service so endpoints can call WatchUser when
// a new tenant is provisioned.
public sealed class VaultObserver : BackgroundService
{
    private readonly VaultObserverOptions _options;
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly WriteRing _writeRing;
    private readonly SearchIndexService? _search;
    private readonly ConflictState? _conflicts;
    private readonly IHubContext<NotesHub>? _hub;
    private readonly ILogger<VaultObserver> _logger;

    // One watcher per tenant, keyed by userId.
    private readonly ConcurrentDictionary<string, FileSystemWatcher> _watchers =
        new(StringComparer.Ordinal);

    // One live debounce timer per path; a new event cancels and restarts it.
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _debounce =
        new(StringComparer.OrdinalIgnoreCase);

    // Test hook: number of debounced flushes actually applied (self-writes and
    // cancelled bursts do not count).
    internal int ProcessedEvents;

    public VaultObserver(
        VaultObserverOptions options,
        MarkdownStorageService storage,
        VaultState state,
        WriteRing writeRing,
        ILogger<VaultObserver> logger,
        IHubContext<NotesHub>? hub = null,
        SearchIndexService? search = null,
        ConflictState? conflicts = null)
    {
        _options = options;
        _storage = storage;
        _state = state;
        _writeRing = writeRing;
        _logger = logger;
        _hub = hub;
        _search = search;
        _conflicts = conflicts;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(_options.UsersDir);
        // Pick up tenants that already have a vault on disk (re-mounted volume).
        foreach (var userDir in Directory.EnumerateDirectories(_options.UsersDir))
            WatchUser(Path.GetFileName(userDir));
        return Task.CompletedTask;
    }

    // Start watching a tenant's notes vault. Idempotent — provisioning a user that
    // is already watched is a no-op. Called on boot for existing tenants and from
    // the setup/provision flow for new ones.
    public void WatchUser(string userId)
    {
        _watchers.GetOrAdd(userId, uid =>
        {
            var notesDir = _options.UserNotesDir(uid);
            Directory.CreateDirectory(notesDir);

            var watcher = new FileSystemWatcher(notesDir, "*.md")
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            watcher.Created += (_, e) => Schedule(uid, e.FullPath, deleted: false);
            watcher.Changed += (_, e) => Schedule(uid, e.FullPath, deleted: false);
            watcher.Deleted += (_, e) => Schedule(uid, e.FullPath, deleted: true);
            watcher.Renamed += (_, e) =>
            {
                Schedule(uid, e.OldFullPath, deleted: true);
                Schedule(uid, e.FullPath, deleted: false);
            };
            watcher.EnableRaisingEvents = true;

            _logger.LogInformation("Watching notes vault for user {User} at {Dir}", uid, notesDir);
            return watcher;
        });
    }

    // Per-path debounce: each new event for a path cancels the pending flush and
    // restarts the window, so N rapid events collapse into one logical update.
    private void Schedule(string userId, string path, bool deleted)
    {
        var cts = new CancellationTokenSource();
        _debounce.AddOrUpdate(path, cts, (_, old) =>
        {
            old.Cancel();
            old.Dispose();
            return cts;
        });

        _ = FlushAfterDelay(userId, path, deleted, cts.Token);
    }

    private async Task FlushAfterDelay(string userId, string path, bool deleted, CancellationToken token)
    {
        try
        {
            await Task.Delay(_options.DebounceMs, token);
        }
        catch (OperationCanceledException)
        {
            return; // superseded by a newer event for this path
        }

        _debounce.TryRemove(path, out var done);
        done?.Dispose();

        // Ignore the echo of our own atomic write — re-parsing it would loop.
        if (_writeRing.IsSelfWrite(path))
        {
            _logger.LogDebug("Ignoring self-write echo: {Path}", path);
            return;
        }

        // A sync tool's conflict copy is not a note — register it for resolution
        // instead of parsing it (it carries the parent's id and would collide).
        if (ConflictDetector.IsConflict(Path.GetFileName(path)))
        {
            await HandleConflict(userId, path, deleted, token);
            Interlocked.Increment(ref ProcessedEvents);
            return;
        }

        try
        {
            if (deleted || !File.Exists(path))
            {
                if (_state.TryGet(userId, path, out var gone) && gone is not null)
                {
                    _state.Remove(userId, path);
                    _search?.RemoveNote(gone.Id);
                    await Broadcast("NoteDeleted", gone, token);
                }
            }
            else
            {
                var note = await _storage.ReadAsync(path, token);
                if (note is not null)
                {
                    var existed = _state.TryGet(userId, path, out _);
                    _state.Upsert(userId, path, note);
                    _search?.IndexNote(userId, note);
                    await Broadcast(existed ? "NoteUpdated" : "NoteCreated", note, token);
                }
            }

            Interlocked.Increment(ref ProcessedEvents);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to sync vault for {Path}", path);
        }
    }

    // Push a metadata-only event to all clients. Body never crosses the wire —
    // clients fetch it via REST only for the open note.
    private Task Broadcast(string evt, Models.Note note, CancellationToken token)
    {
        if (_hub is null) return Task.CompletedTask;
        return _hub.Clients.All.SendAsync(evt, NoteMetadata.From(note), token);
    }

    // Track a conflict copy appearing/vanishing in the vault. On appear it's read
    // once for its title + parent id and registered; on delete (resolved by us or
    // the user) it's dropped. Clients only refetch on these, so the payload is thin.
    private async Task HandleConflict(string userId, string path, bool deleted, CancellationToken token)
    {
        if (_conflicts is null) return;
        var notesDir = _options.UserNotesDir(userId);
        var rel = Path.GetRelativePath(notesDir, path);
        var id = ConflictDetector.EncodeId(rel);

        if (deleted || !File.Exists(path))
        {
            if (_conflicts.Remove(userId, id, out var gone) && gone is not null)
                await BroadcastConflict("ConflictResolved", gone, token);
            return;
        }

        var note = await _storage.ReadAsync(path, token);
        if (note is null) return;

        var parentRel = ConflictDetector.ParentRelativePath(rel);
        var parentId = note.Id;
        if (string.IsNullOrEmpty(parentId) &&
            _state.TryGet(userId, Path.Combine(notesDir, parentRel), out var parent) && parent is not null)
            parentId = parent.Id;

        var info = new ConflictInfo(id, rel, parentRel, parentId ?? string.Empty, note.Title, DateTime.UtcNow);
        _conflicts.Upsert(userId, info);
        await BroadcastConflict("NoteConflict", info, token);
    }

    private Task BroadcastConflict(string evt, ConflictInfo info, CancellationToken token)
    {
        if (_hub is null) return Task.CompletedTask;
        return _hub.Clients.All.SendAsync(evt, new { info.Id, info.ParentId }, token);
    }

    public override void Dispose()
    {
        foreach (var watcher in _watchers.Values) watcher.Dispose();
        foreach (var cts in _debounce.Values) cts.Dispose();
        base.Dispose();
    }
}
