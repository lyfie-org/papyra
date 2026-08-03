using System.Collections.Concurrent;
using System.Text;
using Papyra.Api.Models;
using Whisper.net;

namespace Papyra.Api.Storage;

// Offline speech-to-text for audio dropped into a tenant's media dir. Watches each
// user's media folder for new .wav/.mp3/.m4a files, transcribes them with a local
// Whisper model, and appends the text to whichever note embeds that file, as a
// `> [Transcription]:` blockquote.
//
// Graceful degradation: if no Whisper model is configured/present (or the runtime
// fails to load), the service logs once and stays idle — the rest of the app is
// unaffected. Transcriptions are serialized through a SemaphoreSlim(1) so a batch of
// dropped files can't saturate the container's CPU.
//
// Note: only WAV is decoded in-process; .mp3/.m4a are watched but need an external
// converter (not bundled), so they're logged and skipped rather than failing.
public sealed class AudioTranscriptionService : BackgroundService
{
    private static readonly string[] AudioExtensions = [".wav", ".mp3", ".m4a"];

    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly VaultState _state;
    private readonly MarkdownStorageService _storage;
    private readonly WriteRing _writeRing;
    private readonly SearchIndexService _search;
    private readonly ILogger<AudioTranscriptionService> _logger;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<FileSystemWatcher> _watchers = new();
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.OrdinalIgnoreCase);
    private WhisperFactory? _factory;

    public AudioTranscriptionService(
        IConfiguration config,
        IHostEnvironment env,
        VaultState state,
        MarkdownStorageService storage,
        WriteRing writeRing,
        SearchIndexService search,
        ILogger<AudioTranscriptionService> logger)
    {
        _config = config;
        _env = env;
        _state = state;
        _storage = storage;
        _writeRing = writeRing;
        _search = search;
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var modelPath = _config["Whisper:ModelPath"];
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            _logger.LogInformation(
                "Audio transcription disabled: no Whisper model at '{Path}' (set Whisper:ModelPath to enable).",
                modelPath ?? string.Empty);
            return Task.CompletedTask;
        }

        try
        {
            _factory = WhisperFactory.FromPath(modelPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load Whisper model; audio transcription disabled.");
            return Task.CompletedTask;
        }

        var usersDir = PapyraPaths.UsersDir(_config, _env.ContentRootPath);
        if (!Directory.Exists(usersDir)) return Task.CompletedTask;

        foreach (var userDir in Directory.EnumerateDirectories(usersDir))
            WatchUserMedia(Path.GetFileName(userDir));

        _logger.LogInformation("Audio transcription enabled; watching {Count} media folder(s).", _watchers.Count);
        return Task.CompletedTask;
    }

    private void WatchUserMedia(string userId)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, userId);
        Directory.CreateDirectory(mediaDir);

        var watcher = new FileSystemWatcher(mediaDir)
        {
            IncludeSubdirectories = false,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size,
        };
        watcher.Created += (_, e) => OnAudioFile(userId, e.FullPath);
        watcher.Renamed += (_, e) => OnAudioFile(userId, e.FullPath);
        watcher.EnableRaisingEvents = true;
        _watchers.Add(watcher);
    }

    private void OnAudioFile(string userId, string path)
    {
        if (!AudioExtensions.Contains(Path.GetExtension(path).ToLowerInvariant())) return;
        _ = ProcessAsync(userId, path, CancellationToken.None);
    }

    private async Task ProcessAsync(string userId, string path, CancellationToken ct)
    {
        if (!_inFlight.TryAdd(path, 0)) return; // ignore duplicate events for one file
        await _gate.WaitAsync(ct); // one transcription at a time — Whisper is CPU-heavy
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(500), ct); // let the file finish copying
            var text = await TranscribeAsync(path, ct);
            if (string.IsNullOrWhiteSpace(text)) return;
            AppendToParentNote(userId, Path.GetFileName(path), text, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Transcription failed for {Path}", path);
        }
        finally
        {
            _gate.Release();
            _inFlight.TryRemove(path, out _);
        }
    }

    private async Task<string?> TranscribeAsync(string path, CancellationToken ct)
    {
        if (!string.Equals(Path.GetExtension(path), ".wav", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation(
                "Skipping {File}: only WAV is transcribed in-process (compressed audio needs an external decoder).",
                Path.GetFileName(path));
            return null;
        }

        await using var audio = File.OpenRead(path);
        using var processor = _factory!.CreateBuilder().Build();
        var sb = new StringBuilder();
        await foreach (var segment in processor.ProcessAsync(audio, ct))
            sb.Append(segment.Text);
        return sb.ToString().Trim();
    }

    // Append the transcription to whichever of the user's notes embeds this file.
    private void AppendToParentNote(string userId, string filename, string text, CancellationToken ct)
    {
        var note = _state.Snapshot(userId)
            .FirstOrDefault(n => !n.Trashed && !string.IsNullOrEmpty(n.Body)
                                 && n.Body.Contains(filename, StringComparison.OrdinalIgnoreCase));
        if (note is null)
        {
            _logger.LogInformation("Transcribed {File} but no note references it; nothing to append.", filename);
            return;
        }

        var path = _state.PathFor(userId, note.Id);
        if (path is null) return;

        note.Body = AppendTranscription(note.Body, text);
        note.Updated = DateTime.UtcNow;
        _writeRing.Mark(path); // our write — the notes watcher ignores the echo
        _storage.WriteAsync(path, note, ct).GetAwaiter().GetResult();
        _state.Upsert(userId, path, note);
        _search.IndexNote(userId, note);
        _logger.LogInformation("Appended transcription of {File} to note {NoteId}.", filename, note.Id);
    }

    // The append format is pure + deterministic, so it's a unit-testable seam.
    internal static string AppendTranscription(string body, string text)
    {
        var trimmed = (body ?? string.Empty).TrimEnd();
        var prefix = trimmed.Length == 0 ? string.Empty : trimmed + "\n\n";
        return $"{prefix}> [Transcription]: {text.Trim()}\n";
    }

    public override void Dispose()
    {
        foreach (var w in _watchers) w.Dispose();
        _factory?.Dispose();
        _gate.Dispose();
        base.Dispose();
    }
}
