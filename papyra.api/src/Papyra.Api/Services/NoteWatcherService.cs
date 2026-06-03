using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

public sealed class NoteWatcherService : IHostedService, IDisposable
{
    private readonly IMarkdownStorageService _storage;
    private readonly ILogger<NoteWatcherService> _logger;
    private readonly string _storageRoot;
    private readonly IndexManager? _indexManager;
    private readonly FuzzyIndexService? _fuzzyIndex;
    private readonly IHubContext<NotesHub, INotesClient>? _hubContext;
    private readonly ShareService? _shares;
    private FileSystemWatcher? _watcher;

    private readonly ConcurrentDictionary<string, CancellationTokenSource> _debounce
        = new(StringComparer.OrdinalIgnoreCase);

    // Per-note write semaphore: key = absolute path to note.md
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _noteLocks
        = new(StringComparer.OrdinalIgnoreCase);

    // Key = absolute path to note.md; Value = frontmatter metadata (no body).
    public ConcurrentDictionary<string, NoteMetadata> Notes { get; }
        = new(StringComparer.OrdinalIgnoreCase);

    // Secondary index: noteId → file path — enables O(1) FindNote/ReadFullNote lookups.
    private readonly ConcurrentDictionary<string, string> _idToPath
        = new(StringComparer.OrdinalIgnoreCase);

    public string StorageRoot => _storageRoot;

    public NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        IConfiguration configuration,
        IndexManager indexManager,
        FuzzyIndexService fuzzyIndex,
        ShareService shares,
        IHubContext<NotesHub, INotesClient> hubContext)
    {
        _storage      = storage;
        _logger       = logger;
        _storageRoot  = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _indexManager = indexManager;
        _fuzzyIndex   = fuzzyIndex;
        _shares       = shares;
        _hubContext   = hubContext;
    }

    internal NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        string storageRoot,
        IndexManager? indexManager = null,
        FuzzyIndexService? fuzzyIndex = null,
        ShareService? shares = null,
        IHubContext<NotesHub, INotesClient>? hubContext = null)
    {
        _storage      = storage;
        _logger       = logger;
        _storageRoot  = storageRoot;
        _indexManager = indexManager;
        _fuzzyIndex   = fuzzyIndex;
        _shares       = shares;
        _hubContext   = hubContext;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_storageRoot);
        LoadAll();
        _fuzzyIndex?.Seed(Notes.Values);
        StartWatcher();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _watcher?.Dispose();
        _watcher = null;
        foreach (var cts in _debounce.Values) cts.Cancel();
        _debounce.Clear();
        return Task.CompletedTask;
    }

    public void Dispose() => _watcher?.Dispose();

    // Concurrent-safe write to a note.md file.
    public async Task SafeWriteNoteAsync(string path, string serializedContent)
    {
        var sem = _noteLocks.GetOrAdd(path, _ => new SemaphoreSlim(1, 1));
        await sem.WaitAsync();
        try { await File.WriteAllTextAsync(path, serializedContent); }
        finally { sem.Release(); }
    }

    // Reads the full note (metadata + body) from disk by note ID.
    // Only called for detail endpoint and write mutations — never for list operations.
    // O(1) via the secondary noteId→path index.
    public Note? ReadFullNote(string noteId)
    {
        if (!_idToPath.TryGetValue(noteId, out var path)) return null;

        try
        {
            var raw = ReadWithRetry(path);
            return _storage.DeserializeNote(raw);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read full note body for {NoteId}", noteId);
            return null;
        }
    }

    // Returns (path, meta) for a note ID, or null if not found.
    // O(1) via the secondary noteId→path index.
    public (string Path, NoteMetadata Meta)? FindNote(string noteId)
    {
        if (!_idToPath.TryGetValue(noteId, out var path)) return null;
        if (!Notes.TryGetValue(path, out var meta)) return null;
        return (path, meta);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private static bool IsSystemPath(string path) =>
        path.Contains(".system", StringComparison.OrdinalIgnoreCase);

    private void LoadAll()
    {
        foreach (var path in Directory.EnumerateFiles(_storageRoot, "note.md", SearchOption.AllDirectories))
        {
            if (!IsSystemPath(path)) TryLoad(path);
        }
    }

    private void TryLoad(string path)
    {
        try
        {
            NoteMetadata meta;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                meta = _storage.ParseFrontmatterOnly(fs);

            // Update Lucene and fuzzy index BEFORE the dict so callers that poll
            // the dict can immediately run a search after the note appears.
            _indexManager?.UpdateIndex(meta, path);
            _fuzzyIndex?.Upsert(meta.Id, meta.Title, meta.Tags);

            var isNew = !Notes.ContainsKey(path);
            Notes[path] = meta;
            _idToPath[meta.Id] = path;   // maintain secondary index

            if (_hubContext is not null)
            {
                // Broadcast only to users permitted to see this note:
                // the owner + any active share grantees.
                if (string.IsNullOrEmpty(meta.Owner))
                {
                    _ = isNew
                        ? _hubContext.Clients.All.NoteCreated(meta)
                        : _hubContext.Clients.All.NoteUpdated(meta);
                }
                else
                {
                    var targets = GetPermittedUserIds(meta);
                    var group   = _hubContext.Clients.Users(targets);
                    _ = isNew ? group.NoteCreated(meta) : group.NoteUpdated(meta);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load note from {Path}", path);
        }
    }

    // Returns the SignalR user IDs that are permitted to receive events for this note.
    private IReadOnlyList<string> GetPermittedUserIds(NoteMetadata meta)
    {
        var targets = new List<string> { meta.Owner };
        if (_shares is not null)
        {
            foreach (var share in _shares.GetSharesForNote(meta.Id))
            {
                if (share.Grantee is not null)
                    targets.Add(share.Grantee);
            }
        }
        return targets;
    }

    private void BroadcastDeleted(NoteMetadata deleted)
    {
        if (_hubContext is null) return;
        if (string.IsNullOrEmpty(deleted.Owner))
            _ = _hubContext.Clients.All.NoteDeleted(deleted.Id);
        else
            _ = _hubContext.Clients.Users(GetPermittedUserIds(deleted)).NoteDeleted(deleted.Id);
    }

    // Exponential back-off: 50 ms × 2^attempt, capped at 1 s.
    private static string ReadWithRetry(string path, int maxAttempts = 10)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var fs = new FileStream(
                    path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var sr = new StreamReader(fs);
                return sr.ReadToEnd();
            }
            catch (IOException) when (attempt < maxAttempts)
            {
                Thread.Sleep(Math.Min(50 * (1 << attempt), 1000));
            }
        }
    }

    private void ScheduleLoad(string path)
    {
        if (_debounce.TryRemove(path, out var existing))
            existing.Cancel();

        var cts = new CancellationTokenSource();
        _debounce[path] = cts;

        _ = Task.Delay(300, cts.Token).ContinueWith(t =>
        {
            if (t.IsCanceled) return;
            _debounce.TryRemove(path, out _);
            TryLoad(path);
        }, TaskScheduler.Default);
    }

    private void StartWatcher()
    {
        _watcher = new FileSystemWatcher(_storageRoot, "note.md")
        {
            IncludeSubdirectories = true,
            NotifyFilter          = NotifyFilters.FileName | NotifyFilters.LastWrite,
            EnableRaisingEvents   = true,
        };

        _watcher.Created += (_, e) => { if (!IsSystemPath(e.FullPath)) ScheduleLoad(e.FullPath); };
        _watcher.Changed += (_, e) => { if (!IsSystemPath(e.FullPath)) ScheduleLoad(e.FullPath); };

        _watcher.Deleted += (_, e) =>
        {
            if (IsSystemPath(e.FullPath)) return;
            if (_debounce.TryRemove(e.FullPath, out var cts)) cts.Cancel();
            if (Notes.TryRemove(e.FullPath, out var deleted))
            {
                _idToPath.TryRemove(deleted.Id, out var _deletedPath);
                _noteLocks.TryRemove(e.FullPath, out var removedLock);
                removedLock?.Dispose();
                _fuzzyIndex?.Remove(deleted.Id);
                _indexManager?.RemoveFromIndex(deleted.Id);
                BroadcastDeleted(deleted);
            }
        };

        _watcher.Renamed += (_, e) =>
        {
            if (!IsSystemPath(e.OldFullPath) &&
                e.OldFullPath.EndsWith("note.md", StringComparison.OrdinalIgnoreCase))
            {
                if (_debounce.TryRemove(e.OldFullPath, out var cts)) cts.Cancel();
                if (Notes.TryRemove(e.OldFullPath, out var renamedOld))
                {
                    _idToPath.TryRemove(renamedOld.Id, out var _renamedPath);
                    _noteLocks.TryRemove(e.OldFullPath, out var removedLock);
                    removedLock?.Dispose();
                    _fuzzyIndex?.Remove(renamedOld.Id);
                    _indexManager?.RemoveFromIndex(renamedOld.Id);
                    BroadcastDeleted(renamedOld);
                }
            }
            if (!IsSystemPath(e.FullPath) &&
                e.FullPath.EndsWith("note.md", StringComparison.OrdinalIgnoreCase))
                ScheduleLoad(e.FullPath);
        };
    }
}
