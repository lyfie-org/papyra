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
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ColdBootDiffService> _logger;

    public ColdBootDiffService(
        VaultObserverOptions options,
        MarkdownStorageService storage,
        VaultState state,
        SearchIndexService search,
        IServiceScopeFactory scopeFactory,
        ILogger<ColdBootDiffService> logger)
    {
        _options = options;
        _storage = storage;
        _state = state;
        _search = search;
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

    // Walk the vault, hydrate VaultState, and reconcile the index/cache against
    // disk: index files that are new or changed since the cache last saw them,
    // and drop cache+index entries whose .md file vanished while we were down.
    internal async Task RunDiffAsync(AppDbContext db, CancellationToken ct)
    {
        Directory.CreateDirectory(_options.NotesDir);

        var cached = await db.NoteCache.ToDictionaryAsync(n => n.Id, ct);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int indexed = 0, removed = 0;

        foreach (var path in Directory.EnumerateFiles(_options.NotesDir, "*.md", SearchOption.AllDirectories))
        {
            var note = await _storage.ReadAsync(path, ct);
            if (note is null || string.IsNullOrEmpty(note.Id)) continue;

            seen.Add(note.Id);
            _state.Upsert(path, note); // hydrate the in-memory vault on boot

            var mtime = File.GetLastWriteTimeUtc(path);
            if (!cached.TryGetValue(note.Id, out var row) || row.LastModified != mtime)
            {
                _search.IndexNote(note);
                UpsertCache(db, row, note, mtime);
                indexed++;
            }
        }

        foreach (var (id, row) in cached)
        {
            if (seen.Contains(id)) continue;
            _search.RemoveNote(id); // file deleted while offline
            db.NoteCache.Remove(row);
            removed++;
        }

        await db.SaveChangesAsync(ct);
        _logger.LogInformation(
            "Cold-boot diff: {Loaded} note(s) on disk, {Indexed} (re)indexed, {Removed} pruned",
            seen.Count, indexed, removed);
    }

    private static void UpsertCache(AppDbContext db, NoteCache? existing, Note note, DateTime mtime)
    {
        if (existing is null)
        {
            db.NoteCache.Add(new NoteCache
            {
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
