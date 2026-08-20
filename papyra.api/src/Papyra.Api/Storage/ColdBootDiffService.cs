using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Cold-boot reconciliation: edits made while the container was down are invisible
// until the disk and the disposable caches (VaultState, Lucene, NoteCache) are
// reconciled. Runs once in StartAsync — before Kestrel opens its ports — so the
// first request already sees an accurate index. Diff is by LastWriteTimeUtc.
// Registered as a hosted service (not BackgroundService: ExecuteAsync would run
// after startup, too late).
public sealed class ColdBootDiffService : IHostedService
{
    private readonly VaultObserverOptions _options;
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly ConflictState? _conflicts;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ColdBootDiffService> _logger;

    public ColdBootDiffService(
        VaultObserverOptions options,
        MarkdownStorageService storage,
        VaultState state,
        SearchIndexService search,
        IServiceScopeFactory scopeFactory,
        ILogger<ColdBootDiffService> logger,
        ConflictState? conflicts = null)
    {
        _options = options;
        _storage = storage;
        _state = state;
        _search = search;
        _conflicts = conflicts;
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await RunDiffAsync(db, cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    // Walk every tenant's vault, hydrate VaultState, and reconcile the index/cache
    // against disk: index files that are new or changed since the cache last saw
    // them, and drop cache+index entries whose .md file vanished while we were down.
    internal async Task RunDiffAsync(AppDbContext db, CancellationToken ct)
    {
        Directory.CreateDirectory(_options.UsersDir);

        // Keyed by (userId, noteId), never noteId alone: the same id legitimately
        // exists in more than one vault (every mentioned user owns an "Inbox"
        // note), and collapsing them here made the second tenant's row a
        // duplicate-key insert that threw out of StartAsync — i.e. the container
        // crash-looped and never served a request.
        var cached = await db.NoteCache
            .ToDictionaryAsync(n => (n.UserId, n.Id), ct);
        var seen = new HashSet<(string UserId, string Id)>();
        int indexed = 0, removed = 0;

        foreach (var userDir in Directory.EnumerateDirectories(_options.UsersDir))
        {
            var userId = Path.GetFileName(userDir);
            var notesDir = _options.UserNotesDir(userId);
            if (!Directory.Exists(notesDir)) continue;

            foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
            {
                // Conflict copies are not notes — register them for resolution and
                // keep them out of the vault/index (they'd collide on the parent id).
                if (ConflictDetector.IsConflict(Path.GetFileName(path)))
                {
                    await RegisterConflict(userId, notesDir, path, ct);
                    continue;
                }

                var note = await _storage.ReadAsync(path, ct);
                if (note is null || string.IsNullOrEmpty(note.Id)) continue;

                seen.Add((userId, note.Id));
                _state.Upsert(userId, path, note); // hydrate the in-memory vault on boot

                var mtime = File.GetLastWriteTimeUtc(path);
                if (!cached.TryGetValue((userId, note.Id), out var row) || row.LastModified != mtime)
                {
                    _search.IndexNote(userId, note);
                    UpsertCache(db, row, note, userId, mtime);
                    indexed++;
                }
            }
        }

        foreach (var (key, row) in cached)
        {
            if (seen.Contains(key)) continue;
            _search.RemoveNote(key.UserId, key.Id); // file deleted while offline
            db.NoteCache.Remove(row);
            removed++;
        }

        await db.SaveChangesAsync(ct);
        _logger.LogInformation(
            "Cold-boot diff: {Loaded} note(s) on disk, {Indexed} (re)indexed, {Removed} pruned",
            seen.Count, indexed, removed);
    }

    // Rehydrate one conflict copy into the (disposable) conflict registry on boot.
    private async Task RegisterConflict(string userId, string notesDir, string path, CancellationToken ct)
    {
        if (_conflicts is null) return;
        var note = await _storage.ReadAsync(path, ct);
        var rel = Path.GetRelativePath(notesDir, path);
        _conflicts.Upsert(userId, new ConflictInfo(
            ConflictDetector.EncodeId(rel),
            rel,
            ConflictDetector.ParentRelativePath(rel),
            note?.Id ?? string.Empty,
            note?.Title ?? string.Empty,
            File.GetLastWriteTimeUtc(path)));
    }

    private static void UpsertCache(
        AppDbContext db, NoteCache? existing, Note note, string userId, DateTime mtime)
    {
        if (existing is null)
        {
            db.NoteCache.Add(new NoteCache
            {
                UserId = userId,
                Id = note.Id,
                Title = note.Title,
                Tags = string.Join(' ', note.Tags),
                LastModified = mtime,
            });
        }
        else
        {
            existing.Title = note.Title;
            existing.Tags = string.Join(' ', note.Tags);
            existing.LastModified = mtime;
        }
    }
}
