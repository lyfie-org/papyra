using System.Text;
using Whisper.net;

namespace Papyra.Api.Storage;

// Offline speech-to-text for recordings embedded in notes, with a local Whisper
// model. Runs as a MediaJobQueue handler: the queue decides when, stores the
// transcript as a sidecar (MediaTextStore, searchable through every note that
// embeds the file) and then this appends it to the note as a
// `> [Transcription]: …` quote — through NoteBodyWriter, so it is snapshotted,
// merged into a live room rather than written over it, and shown in an open
// editor.
//
// Graceful degradation: with no model configured/present (or a runtime load
// failure), Enabled is false and nothing is queued for it. Only WAV is decoded
// in-process; compressed audio would need an external decoder (not bundled), so
// it isn't accepted.
public sealed class AudioTranscriptionService : IMediaJobHandler, IDisposable
{
    private readonly string? _modelPath;
    private readonly VaultState _state;
    private readonly MediaReferences _refs;
    private readonly NoteBodyWriter _writer;
    private readonly ILogger<AudioTranscriptionService> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private WhisperFactory? _factory;
    private bool _broken;

    public AudioTranscriptionService(IConfiguration config, VaultState state, MediaReferences refs,
        NoteBodyWriter writer, ILogger<AudioTranscriptionService> logger)
    {
        _state = state;
        _refs = refs;
        _writer = writer;
        _logger = logger;
        var modelPath = config["Whisper:ModelPath"];
        _modelPath = !string.IsNullOrWhiteSpace(modelPath) && File.Exists(modelPath) ? modelPath : null;
        if (_modelPath is null)
            logger.LogInformation(
                "Audio transcription disabled: no Whisper model at '{Path}' (set Whisper:ModelPath to enable).",
                modelPath ?? string.Empty);
    }

    public string Kind => MediaTextStore.Transcript;

    public bool Enabled => _modelPath is not null && !_broken;

    public bool Accepts(string fileName) =>
        string.Equals(Path.GetExtension(fileName), ".wav", StringComparison.OrdinalIgnoreCase);

    public async Task<string> ExtractAsync(string mediaPath, CancellationToken ct)
    {
        await _gate.WaitAsync(ct); // Whisper is CPU-heavy: one at a time
        try
        {
            var factory = Factory() ?? throw new InvalidOperationException("Whisper model unavailable.");
            await using var audio = File.OpenRead(mediaPath);
            using var processor = factory.CreateBuilder().Build();
            var sb = new StringBuilder();
            await foreach (var segment in processor.ProcessAsync(audio, ct))
                sb.Append(segment.Text);
            return sb.ToString().Trim();
        }
        finally
        {
            _gate.Release();
        }
    }

    // Add the transcript to the note that embeds the recording (the first by
    // id if several do, so it is always the same one). A Secure note is left alone: its text would then be
    // readable outside the vault in places that show note bodies.
    public async Task CompletedAsync(string ownerUid, string fileName, string text, CancellationToken ct)
    {
        var note = _state.Snapshot(ownerUid)
            .Where(n => !n.Trashed && !n.Secure && _refs.References(n, fileName))
            .OrderBy(n => n.Id, StringComparer.Ordinal)
            .FirstOrDefault();
        if (note is null)
        {
            _logger.LogInformation("Transcribed {File}; no ordinary note embeds it, so nothing was appended.", fileName);
            return;
        }

        await _writer.ChangeAsync(ownerUid, note.Id, current =>
            current.Secure || current.Trashed ? NoteEdit.Keep : new NoteEdit(AppendTranscription(current.Body, text)),
            LiveRoomPolicy.Merge, ct);
        _logger.LogInformation("Appended transcription of {File} to note {NoteId}.", fileName, note.Id);
    }

    private WhisperFactory? Factory()
    {
        if (_factory is not null || _broken || _modelPath is null) return _factory;
        try
        {
            _factory = WhisperFactory.FromPath(_modelPath);
            _logger.LogInformation("Audio transcription enabled.");
        }
        catch (Exception ex)
        {
            _broken = true;
            _logger.LogWarning(ex, "Failed to load Whisper model; audio transcription disabled.");
        }
        return _factory;
    }

    // The append format is pure + deterministic, so it's a unit-testable seam.
    internal static string AppendTranscription(string body, string text)
    {
        var trimmed = (body ?? string.Empty).TrimEnd();
        var prefix = trimmed.Length == 0 ? string.Empty : trimmed + "\n\n";
        return $"{prefix}> [Transcription]: {text.Trim()}\n";
    }

    public void Dispose()
    {
        _factory?.Dispose();
        _gate.Dispose();
    }
}
