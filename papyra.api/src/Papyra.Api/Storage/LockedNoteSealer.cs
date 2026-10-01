using Papyra.Api.Collab;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// Puts locked notes into their encrypted form on disk wherever they are still
/// readable: files written before encryption at rest existed, a locked file a
/// sync tool or editor rewrote in the clear, the history of a note that has just
/// been locked, and the live-collaboration state a note had before its lock.
/// <see cref="MarkdownStorageService"/> does the sealing; this finds what needs it.
/// Registered as a singleton.
/// </summary>
public sealed class LockedNoteSealer
{
    // Written once a user's whole history has been swept; later boots only
    // check the live notes (history is only ever written sealed from then on).
    private const string HistoryMarker = "history-sealed-v1";

    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly WriteRing _writeRing;
    private readonly CollabStateStore? _collabStates;
    private readonly IConfiguration _config;
    private readonly string _contentRoot;
    private readonly ILogger<LockedNoteSealer> _logger;

    public LockedNoteSealer(MarkdownStorageService storage, VaultState state, WriteRing writeRing,
        IConfiguration config, IHostEnvironment env, ILogger<LockedNoteSealer> logger, CollabStateStore? collabStates = null)
    {
        _storage = storage;
        _state = state;
        _writeRing = writeRing;
        _config = config;
        _contentRoot = env.ContentRootPath;
        _logger = logger;
        _collabStates = collabStates;
    }

    /// <summary>
    /// Bring a live locked note's file into its sealed form: encrypted when it
    /// was read readable, and under an anonymous file name. Returns where it lives now.
    /// </summary>
    public async Task<string> SealLiveAsync(string uid, string path, Note note, CancellationToken ct)
    {
        if (!note.Secure) return path;
        if (note.NeedsSealing)
        {
            _writeRing.Mark(path);
            await _storage.WriteAsync(path, note, ct);
            note.NeedsSealing = false;
            _state.Upsert(uid, path, note);
        }
        var target = NoteFileNamer.TargetPath(path, NoteFileNamer.DesiredBaseName(note), note.Id);
        return NoteFileNamer.Move(uid, path, target, _state, _writeRing, _logger);
    }

    /// <summary>
    /// Seal every archived version of a note that is now locked. A version from
    /// before the lock holds exactly what the lock now protects, so it is marked
    /// locked too (restoring it keeps the note locked). Also drops the note's
    /// saved live-editing state, which holds its text in the clear.
    /// </summary>
    public async Task<int> SealHistoryAsync(string uid, string noteId, CancellationToken ct)
    {
        _collabStates?.Delete(uid, noteId);
        if (!PathGuard.IsValidNoteId(noteId)) return 0;
        var dir = Path.Combine(PapyraPaths.UserSnapshotsDir(_config, _contentRoot, uid), noteId);
        return await SealVersionsAsync(dir, everyVersion: true, ct);
    }

    /// <summary>
    /// The boot sweep: every loaded locked note sealed and anonymously named, and
    /// — once per user — every archived version of a locked note (including those
    /// of notes since deleted). Never throws; a note it can't seal is logged and
    /// left for the next boot.
    /// </summary>
    public async Task SweepAsync(CancellationToken ct)
    {
        int notes = 0, versions = 0;
        foreach (var uid in _state.Users)
        {
            var dot = PapyraPaths.UserDotPapyra(_config, _contentRoot, uid);
            var historyDone = File.Exists(Path.Combine(dot, HistoryMarker));
            var locked = _state.Snapshot(uid).Where(n => n.Secure && !string.IsNullOrEmpty(n.Id)).ToList();
            foreach (var note in locked)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    if (_state.PathFor(uid, note.Id) is not { } path) continue;
                    var needed = note.NeedsSealing;
                    var now = await SealLiveAsync(uid, path, note, ct);
                    if (needed || now != path) notes++;
                    if (!historyDone) versions += await SealHistoryAsync(uid, note.Id, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Could not seal locked note {Id} for user {Uid}", note.Id, uid);
                }
            }

            if (historyDone) continue;
            try
            {
                // Versions of notes that are gone (or not locked any more) that were
                // themselves locked: sealed as they are, flags untouched.
                var root = PapyraPaths.UserSnapshotsDir(_config, _contentRoot, uid);
                if (Directory.Exists(root))
                    foreach (var dir in Directory.EnumerateDirectories(root))
                        versions += await SealVersionsAsync(dir, everyVersion: false, ct);
                Directory.CreateDirectory(dot);
                await File.WriteAllTextAsync(Path.Combine(dot, HistoryMarker), DateTime.UtcNow.ToString("o"), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Could not finish sealing the version history of user {Uid}", uid);
            }
        }
        if (notes + versions > 0)
            _logger.LogInformation("Locked notes: sealed {Notes} note file(s) and {Versions} archived version(s)", notes, versions);
    }

    /// <summary>
    /// Seal the locked notes inside a backup tree that is being restored (its
    /// files live under the user's dir, so they seal under the user's key), and
    /// give them anonymous names before they reach the vault.
    /// </summary>
    public async Task<int> SealFolderAsync(string dir, CancellationToken ct)
    {
        if (!Directory.Exists(dir)) return 0;
        var sealedCount = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.md", SearchOption.AllDirectories).ToList())
        {
            var note = await _storage.ReadAsync(file, ct);
            if (note is null || !note.Secure) continue;
            if (note.NeedsSealing)
            {
                await _storage.WriteAsync(file, note, ct);
                sealedCount++;
            }
            var stem = Path.GetFileNameWithoutExtension(file);
            if (ConflictDetector.IsConflict(Path.GetFileName(file)) || NoteFileNamer.IsLockedName(stem)) continue;
            var target = NoteFileNamer.TargetPath(file, NoteFileNamer.DesiredBaseName(note), note.Id);
            if (target != file) File.Move(file, target);
        }
        return sealedCount;
    }

    private async Task<int> SealVersionsAsync(string dir, bool everyVersion, CancellationToken ct)
    {
        if (!Directory.Exists(dir)) return 0;
        var count = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.md"))
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (!everyVersion && !(await File.ReadAllTextAsync(file, ct)).Contains("secure:", StringComparison.Ordinal)) continue;
                var version = await _storage.ReadAsync(file, ct);
                if (version is null) continue;
                // Sealed already (or sealed under a key this user doesn't hold).
                if (version.Secure && !version.NeedsSealing) continue;
                if (!version.Secure && !everyVersion) continue;
                version.Secure = true;
                var mtime = File.GetLastWriteTimeUtc(file);
                await _storage.WriteAsync(file, version, ct);
                File.SetLastWriteTimeUtc(file, mtime);
                count++;
            }
            catch (Exception ex) when (ex is IOException or System.Security.Cryptography.CryptographicException)
            {
                _logger.LogWarning(ex, "Could not seal archived version {File}", file);
            }
        }
        return count;
    }
}

/// <summary>
/// Runs the <see cref="LockedNoteSealer"/> boot sweep. Registered right after
/// <see cref="ColdBootDiffService"/> (which loads the vault it walks), and
/// awaited before the app serves requests, so nothing readable outlives a boot.
/// </summary>
public sealed class LockedNoteSweepService(LockedNoteSealer sealer) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => sealer.SweepAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
