using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

public sealed class NoteWatcherService : IHostedService, IDisposable
{
    private readonly IMarkdownStorageService _storage;
    private readonly ILogger<NoteWatcherService> _logger;
    private readonly string _notesDirectory;
    private readonly IndexManager? _indexManager;
    private readonly IHubContext<NotesHub, INotesClient>? _hubContext;
    private FileSystemWatcher? _watcher;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _debounce
        = new(StringComparer.OrdinalIgnoreCase);

    public ConcurrentDictionary<string, Note> Notes { get; } = new(StringComparer.OrdinalIgnoreCase);
    public string NotesDirectory => _notesDirectory;

    public NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        IConfiguration configuration,
        IndexManager indexManager,
        IHubContext<NotesHub, INotesClient> hubContext)
    {
        _storage = storage;
        _logger = logger;
        _notesDirectory = configuration["Storage:NotesDirectory"]
            ?? Path.Combine(AppContext.BaseDirectory, "notes");
        _indexManager = indexManager;
        _hubContext = hubContext;
    }

    internal NoteWatcherService(
        IMarkdownStorageService storage,
        ILogger<NoteWatcherService> logger,
        string notesDirectory,
        IndexManager? indexManager = null,
        IHubContext<NotesHub, INotesClient>? hubContext = null)
    {
        _storage = storage;
        _logger = logger;
        _notesDirectory = notesDirectory;
        _indexManager = indexManager;
        _hubContext = hubContext;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_notesDirectory);
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
        foreach (var path in Directory.EnumerateFiles(_notesDirectory, "*.md"))
            TryLoad(path);
    }

    private void TryLoad(string path)
    {
        try
        {
            var content = ReadWithRetry(path);
            var note = _storage.DeserializeNote(content);
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

    // Retries on IOException in case an external editor (Obsidian, Syncthing)
    // hasn't released its file handle yet when the watcher event fires.
    private static string ReadWithRetry(string path, int maxAttempts = 5, int delayMs = 100)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return File.ReadAllText(path); }
            catch (IOException) when (attempt < maxAttempts)
            {
                Thread.Sleep(delayMs);
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
        _watcher = new FileSystemWatcher(_notesDirectory, "*.md")
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
            EnableRaisingEvents = true,
        };

        _watcher.Created += (s, e) => ScheduleLoad(e.FullPath);
        _watcher.Changed += (s, e) => ScheduleLoad(e.FullPath);
        _watcher.Deleted += (s, e) =>
        {
            if (_debounce.TryRemove(e.FullPath, out var cts)) cts.Cancel();
            if (Notes.TryRemove(e.FullPath, out var note))
            {
                _indexManager?.RemoveFromIndex(note.Id);
                _ = _hubContext?.Clients.All.NoteDeleted(note.Id);
            }
        };
        _watcher.Renamed += (s, e) =>
        {
            if (_debounce.TryRemove(e.OldFullPath, out var cts)) cts.Cancel();
            if (Notes.TryRemove(e.OldFullPath, out var old))
            {
                _indexManager?.RemoveFromIndex(old.Id);
                _ = _hubContext?.Clients.All.NoteDeleted(old.Id);
            }
            if (e.FullPath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                ScheduleLoad(e.FullPath);
        };
    }
}
