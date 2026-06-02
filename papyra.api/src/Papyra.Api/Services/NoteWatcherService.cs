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
    private readonly IHubContext<NotesHub, INotesClient>? _hubContext;
    private FileSystemWatcher? _watcher;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _debounce
        = new(StringComparer.OrdinalIgnoreCase);

    // Key = absolute path to note.md; Value = parsed Note.
    public ConcurrentDictionary<string, Note> Notes { get; } = new(StringComparer.OrdinalIgnoreCase);
    public string StorageRoot => _storageRoot;

    public NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        IConfiguration configuration,
        IndexManager indexManager,
        IHubContext<NotesHub, INotesClient> hubContext)
    {
        _storage      = storage;
        _logger       = logger;
        _storageRoot  = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _indexManager = indexManager;
        _hubContext   = hubContext;
    }

    internal NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        string storageRoot,
        IndexManager? indexManager = null,
        IHubContext<NotesHub, INotesClient>? hubContext = null)
    {
        _storage      = storage;
        _logger       = logger;
        _storageRoot  = storageRoot;
        _indexManager = indexManager;
        _hubContext   = hubContext;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_storageRoot);
        LoadAll();
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

    private void LoadAll()
    {
        foreach (var path in Directory.EnumerateFiles(_storageRoot, "note.md", SearchOption.AllDirectories))
            TryLoad(path);
    }

    private void TryLoad(string path)
    {
        try
        {
            var content = ReadWithRetry(path);
            var note    = _storage.DeserializeNote(content);

            // Use note.Id (from YAML frontmatter) as the Lucene key, not the path,
            // so renaming the note directory never creates a duplicate index entry.
            var isNew = !Notes.ContainsKey(path);
            _indexManager?.UpdateIndex(note);
            Notes[path] = note;

            if (isNew)
                _ = _hubContext?.Clients.All.NoteCreated(note);
            else
                _ = _hubContext?.Clients.All.NoteUpdated(note);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load note from {Path}", path);
        }
    }

    // Retries on IOException — handles file locks from Obsidian, Syncthing, or the OS
    // write-cache flushing before the FileSystemWatcher event fires.
    // Uses exponential-ish back-off: 50 ms × 2^attempt, capped at ~1 s.
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
        // Filter = "note.md" + IncludeSubdirectories catches every note file across
        // all [storageRoot]/[noteId]/note.md paths without matching media or other files.
        _watcher = new FileSystemWatcher(_storageRoot, "note.md")
        {
            IncludeSubdirectories = true,
            NotifyFilter          = NotifyFilters.FileName | NotifyFilters.LastWrite,
            EnableRaisingEvents   = true,
        };

        _watcher.Created += (_, e) => ScheduleLoad(e.FullPath);
        _watcher.Changed += (_, e) => ScheduleLoad(e.FullPath);

        _watcher.Deleted += (sender, e) =>
        {
            if (_debounce.TryRemove(e.FullPath, out var cts)) cts.Cancel();
            if (Notes.TryRemove(e.FullPath, out Note? note))
            {
                _indexManager?.RemoveFromIndex(note!.Id);
                _ = _hubContext?.Clients.All.NoteDeleted(note!.Id);
            }
        };

        _watcher.Renamed += (sender, e) =>
        {
            // A note.md renamed away (e.g. Obsidian swap-write) — remove old entry.
            if (e.OldFullPath.EndsWith("note.md", StringComparison.OrdinalIgnoreCase))
            {
                if (_debounce.TryRemove(e.OldFullPath, out var cts)) cts.Cancel();
                if (Notes.TryRemove(e.OldFullPath, out Note? old))
                {
                    _indexManager?.RemoveFromIndex(old!.Id);
                    _ = _hubContext?.Clients.All.NoteDeleted(old!.Id);
                }
            }
            // A file renamed TO note.md — treat as a new/updated note.
            if (e.FullPath.EndsWith("note.md", StringComparison.OrdinalIgnoreCase))
                ScheduleLoad(e.FullPath);
        };
    }
}
