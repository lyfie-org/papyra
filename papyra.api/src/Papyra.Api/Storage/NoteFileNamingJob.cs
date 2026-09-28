namespace Papyra.Api.Storage;

/// <summary>
/// Gives existing notes readable file names. New and edited notes are named as
/// they save (see NoteFileNamer); this catches the rest — notes from before
/// names followed titles, still sitting at <c>3f2c…e9.md</c>, and anything
/// written by another tool under an id. Names a person chose are left alone.
/// </summary>
public sealed class NoteFileNamingJob : PeriodicJob
{
    private readonly VaultState _state;
    private readonly WriteRing _writeRing;
    private readonly ILogger<NoteFileNamingJob> _logger;

    public NoteFileNamingJob(VaultState state, WriteRing writeRing, JobRegistry registry, ILogger<NoteFileNamingJob> logger)
        : base(registry)
    {
        _state = state;
        _writeRing = writeRing;
        _logger = logger;
    }

    protected override string JobId => "file-names";
    protected override string JobName => "Name note files after their titles";
    protected override string JobDescription =>
        "Renames note files that still carry a random id to a readable name taken from the note's title "
        + "(or first line), so the notes folder makes sense on its own. Names you chose yourself are kept.";
    protected override TimeSpan Interval => TimeSpan.FromHours(24);
    // After the cold-boot scan has filled the in-memory vault.
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(2);

    protected override Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var renamed = 0;
        foreach (var uid in _state.Users)
        {
            foreach (var note in _state.Snapshot(uid))
            {
                ct.ThrowIfCancellationRequested();
                if (string.IsNullOrEmpty(note.Id)) continue;
                var path = _state.PathFor(uid, note.Id);
                if (path is null || !File.Exists(path)) continue;
                var target = NoteFileNamer.TargetPath(path, NoteFileNamer.DesiredBaseName(note), note.Id);
                if (target == path) continue;
                if (NoteFileNamer.Move(uid, path, target, _state, _writeRing, _logger) != path) renamed++;
            }
        }
        return Task.FromResult<string?>(renamed == 0 ? null : $"{renamed} file{(renamed == 1 ? "" : "s")} renamed");
    }
}
