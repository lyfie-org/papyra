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
        _notesDirectory = configuration["Notes:Directory"]
            ?? Path.Combine(AppContext.BaseDirectory, "notes");
        _indexManager = indexManager;
        _hubContext = hubContext;
    }

    // Internal constructor keeps existing tests working; indexManager/hubContext optional.
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
            var content = File.ReadAllText(path);
            var note = _storage.DeserializeNote(content);
            var isNew = !Notes.ContainsKey(path);
            // Index before dict so pollers that see note in dict can always search it.
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

    private void StartWatcher()
    {
        _watcher = new FileSystemWatcher(_notesDirectory, "*.md")
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
            EnableRaisingEvents = true,
        };

        _watcher.Created += (s, e) => TryLoad(e.FullPath);
        _watcher.Changed += (s, e) => TryLoad(e.FullPath);
        _watcher.Deleted += (s, e) =>
        {
            if (Notes.TryRemove(e.FullPath, out var note))
            {
                _indexManager?.RemoveFromIndex(note.Id);
                _ = _hubContext?.Clients.All.NoteDeleted(note.Id);
            }
        };
        _watcher.Renamed += (s, e) =>
        {
            if (Notes.TryRemove(e.OldFullPath, out var old))
            {
                _indexManager?.RemoveFromIndex(old.Id);
                _ = _hubContext?.Clients.All.NoteDeleted(old.Id);
            }
            if (e.FullPath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                TryLoad(e.FullPath);
        };
    }
}
