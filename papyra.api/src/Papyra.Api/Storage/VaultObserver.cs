using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;

namespace Papyra.Api.Storage;

public sealed class VaultObserverOptions
{
    // Absolute path to the notes vault watched for .md changes.
    public required string NotesDir { get; init; }

    // Per-path debounce window. One logical change can fire many OS events; we
    // collapse a quiet-for-DebounceMs burst into a single update.
    public int DebounceMs { get; init; } = 200;
}

// Reactive file observer: watches the notes dir and keeps VaultState in sync with
// the .md files on disk. Three guards stop it melting down under sync tools and
// its own writes:
//   • Write-Ring — skip the echo of Papyra's own atomic writes (loop prevention).
//   • Debouncer  — collapse a storm of micro-events per path into one update.
//   • Backoff    — MarkdownStorageService.ReadAsync retries lock-held reads.
// Registered as a hosted service.
public sealed class VaultObserver : BackgroundService
{
    private readonly VaultObserverOptions _options;
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly WriteRing _writeRing;
    private readonly IHubContext<NotesHub>? _hub;
    private readonly ILogger<VaultObserver> _logger;

    // One live debounce timer per path; a new event cancels and restarts it.
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _debounce =
        new(StringComparer.OrdinalIgnoreCase);

    private FileSystemWatcher? _watcher;

    // Test hook: number of debounced flushes actually applied (self-writes and
    // cancelled bursts do not count).
    internal int ProcessedEvents;

    public VaultObserver(
        VaultObserverOptions options,
        MarkdownStorageService storage,
        VaultState state,
        WriteRing writeRing,
        ILogger<VaultObserver> logger,
        IHubContext<NotesHub>? hub = null)
    {
        _options = options;
        _storage = storage;
        _state = state;
        _writeRing = writeRing;
        _logger = logger;
        _hub = hub;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(_options.NotesDir);

        _watcher = new FileSystemWatcher(_options.NotesDir, "*.md")
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
        };
        _watcher.Created += OnChanged;
        _watcher.Changed += OnChanged;
        _watcher.Deleted += OnDeleted;
        _watcher.Renamed += OnRenamed;
        _watcher.EnableRaisingEvents = true;

        _logger.LogInformation("Watching notes vault at {Dir}", _options.NotesDir);
        return Task.CompletedTask;
    }

    private void OnChanged(object sender, FileSystemEventArgs e) => Schedule(e.FullPath, deleted: false);
    private void OnDeleted(object sender, FileSystemEventArgs e) => Schedule(e.FullPath, deleted: true);

    private void OnRenamed(object sender, RenamedEventArgs e)
    {
        Schedule(e.OldFullPath, deleted: true);
        Schedule(e.FullPath, deleted: false);
    }

    // Per-path debounce: each new event for a path cancels the pending flush and
    // restarts the window, so N rapid events collapse into one logical update.
    private void Schedule(string path, bool deleted)
    {
        var cts = new CancellationTokenSource();
        _debounce.AddOrUpdate(path, cts, (_, old) =>
        {
            old.Cancel();
            old.Dispose();
            return cts;
        });

        _ = FlushAfterDelay(path, deleted, cts.Token);
    }

    private async Task FlushAfterDelay(string path, bool deleted, CancellationToken token)
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

        try
        {
            if (deleted || !File.Exists(path))
            {
                if (_state.TryGet(path, out var gone) && gone is not null)
                {
                    _state.Remove(path);
                    await Broadcast("NoteDeleted", gone, token);
                }
            }
            else
            {
                var note = await _storage.ReadAsync(path, token);
                if (note is not null)
                {
                    var existed = _state.TryGet(path, out _);
                    _state.Upsert(path, note);
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

    public override void Dispose()
    {
        _watcher?.Dispose();
        foreach (var cts in _debounce.Values) cts.Dispose();
        base.Dispose();
    }
}
