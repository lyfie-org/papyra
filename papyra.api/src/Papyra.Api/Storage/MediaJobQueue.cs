using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace Papyra.Api.Storage;

/// <summary>
/// Work that reads text out of an attachment (OCR a picture, transcribe a
/// recording). Implementations do the extraction only; <see cref="MediaJobQueue"/>
/// decides when, stores the result and re-indexes the notes that show the file.
/// </summary>
public interface IMediaJobHandler
{
    /// <summary><see cref="MediaTextStore.Ocr"/> or <see cref="MediaTextStore.Transcript"/>.</summary>
    string Kind { get; }

    /// <summary>False when the engine isn't installed/configured: nothing is queued for it.</summary>
    bool Enabled { get; }

    /// <summary>Whether this file (by its stored name) is something it can read.</summary>
    bool Accepts(string fileName);

    /// <summary>The text in the file ("" when there is none). Throws to retry later.</summary>
    Task<string> ExtractAsync(string mediaPath, CancellationToken ct);

    /// <summary>After the text is stored and indexed (a transcript is also added to the note).</summary>
    Task CompletedAsync(string ownerUid, string fileName, string text, CancellationToken ct) => Task.CompletedTask;
}

/// <summary>
/// The one queue for attachment text jobs. It replaces per-service file
/// watchers that only knew the users present at boot (a user created later
/// never got OCR), ran without retries, and kept results only in the index.
/// <list type="bullet">
///   <item>Jobs come from note saves that add a reference (the moment an upload
///   becomes part of a note), a boot scan for referenced files without text, and
///   a per-user media folder watcher (files added outside the app), created lazily.</item>
///   <item>A file no live note references is skipped — it is picked up when one does.</item>
///   <item>Failures retry with backoff (×5), then stop; pending and failed jobs are
///   persisted in <c>.papyra/media-jobs.json</c> so a restart neither loses nor
///   endlessly repeats them.</item>
///   <item>Results go to <see cref="MediaTextStore"/> sidecars and every referencing
///   note is re-indexed (Secure notes index no attachment text).</item>
/// </list>
/// </summary>
public sealed class MediaJobQueue : BackgroundService
{
    public const int MaxAttempts = 5;

    private readonly IReadOnlyList<IMediaJobHandler> _handlers;
    private readonly MediaTextStore _texts;
    private readonly MediaReferences _refs;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly IConfiguration _config;
    private readonly string _contentRoot;
    private readonly ILogger<MediaJobQueue> _logger;

    private readonly Channel<Job> _channel = Channel.CreateUnbounded<Job>();
    private readonly ConcurrentDictionary<string, Job> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Job> _failed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, FileSystemWatcher> _watchers = new(StringComparer.Ordinal);
    private readonly object _persistGate = new();

    /// <summary>Delay before attempt n+1 (n = attempts so far). Tests shorten it.</summary>
    internal Func<int, TimeSpan> Backoff { get; set; } = n => TimeSpan.FromSeconds(30 * Math.Pow(4, n - 1));

    /// <summary>Delay before a job runs, so a file being copied in has settled.</summary>
    internal TimeSpan Settle { get; set; } = TimeSpan.FromMilliseconds(500);

    public MediaJobQueue(IEnumerable<IMediaJobHandler> handlers, MediaTextStore texts, MediaReferences refs,
        VaultState state, SearchIndexService search, IConfiguration config, IHostEnvironment env,
        ILogger<MediaJobQueue> logger)
    {
        _handlers = handlers.ToList();
        _texts = texts;
        _refs = refs;
        _state = state;
        _search = search;
        _config = config;
        _contentRoot = env.ContentRootPath;
        _logger = logger;
        Load();
    }

    public sealed record Job(string UserId, string Name, string Kind, int Attempts = 0, string? LastError = null);

    private static string Key(string uid, string name, string kind) => $"{uid}|{kind}|{name.ToLowerInvariant()}";

    /// <summary>Jobs waiting (including retries), for tests and diagnostics.</summary>
    public IReadOnlyCollection<Job> Pending => _pending.Values.ToList();

    /// <summary>Jobs that gave up after <see cref="MaxAttempts"/>.</summary>
    public IReadOnlyCollection<Job> Failed => _failed.Values.ToList();

    /// <summary>Queue text jobs for the attachments <paramref name="body"/> references that <paramref name="prior"/> didn't.</summary>
    public void EnqueueNewRefs(string uid, string? prior, string? body)
    {
        if (!_handlers.Any(h => h.Enabled) || string.IsNullOrEmpty(body)) return;
        var before = MediaRefParser.Extract(prior);
        foreach (var name in MediaRefParser.Extract(body))
            if (!before.Contains(name)) Enqueue(uid, name);
    }

    /// <summary>Queue every job this file needs and doesn't have yet.</summary>
    public void Enqueue(string uid, string name)
    {
        EnsureWatching(uid);
        foreach (var handler in _handlers)
        {
            if (!handler.Enabled || !handler.Accepts(name)) continue;
            var key = Key(uid, name, handler.Kind);
            if (_pending.ContainsKey(key) || _failed.ContainsKey(key) || _texts.Has(uid, name, handler.Kind)) continue;
            var job = new Job(uid, name, handler.Kind);
            if (!_pending.TryAdd(key, job)) continue;
            Persist();
            _channel.Writer.TryWrite(job);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!_handlers.Any(h => h.Enabled))
        {
            _logger.LogInformation("Attachment text jobs off: no OCR or transcription engine is configured.");
            return;
        }

        // Resume what a previous run left, then look for referenced files that
        // never got their text (uploads while the engine was off, a lost queue).
        foreach (var job in _pending.Values) _channel.Writer.TryWrite(job);
        _ = Task.Run(() => ScanAll(ct), ct);

        await foreach (var job in _channel.Reader.ReadAllAsync(ct))
        {
            try { await RunAsync(job, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) { _logger.LogWarning(ex, "Attachment text job {Kind} {Name} failed unexpectedly", job.Kind, job.Name); }
        }
    }

    private void ScanAll(CancellationToken ct)
    {
        var usersDir = PapyraPaths.UsersDir(_config, _contentRoot);
        if (!Directory.Exists(usersDir)) return;
        foreach (var userDir in Directory.EnumerateDirectories(usersDir))
        {
            if (ct.IsCancellationRequested) return;
            ScanUser(Path.GetFileName(userDir));
        }
    }

    /// <summary>Queue every attachment of this user's notes that has no text yet (after an import).</summary>
    public void ScanUser(string uid)
    {
        if (!_handlers.Any(h => h.Enabled)) return;
        EnsureWatching(uid);
        var mediaDir = PapyraPaths.UserMediaDir(_config, _contentRoot, uid);
        if (!Directory.Exists(mediaDir)) return;
        var referenced = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var note in _state.Snapshot(uid))
            if (!note.Trashed) referenced.UnionWith(_refs.Of(note));
        foreach (var file in Directory.EnumerateFiles(mediaDir))
        {
            var name = Path.GetFileName(file);
            if (referenced.Contains(name)) Enqueue(uid, name);
        }
    }

    internal async Task RunAsync(Job job, CancellationToken ct)
    {
        var key = Key(job.UserId, job.Name, job.Kind);
        var handler = _handlers.FirstOrDefault(h => h.Kind == job.Kind && h.Enabled);
        var path = Path.Combine(PapyraPaths.UserMediaDir(_config, _contentRoot, job.UserId), job.Name);
        // Gone, or no longer part of any note: nothing to do (a later reference re-queues it).
        if (handler is null || !File.Exists(path) || !IsReferenced(job.UserId, job.Name))
        {
            Done(key);
            return;
        }

        await Task.Delay(Settle, ct);
        string text;
        try
        {
            text = (await handler.ExtractAsync(path, ct)).Trim();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var next = job with { Attempts = job.Attempts + 1, LastError = ex.Message };
            if (next.Attempts >= MaxAttempts)
            {
                _pending.TryRemove(key, out _);
                _failed[key] = next;
                Persist();
                _logger.LogWarning(ex, "Gave up reading {Kind} text from {Name} after {Attempts} attempts", job.Kind, job.Name, next.Attempts);
                return;
            }
            _pending[key] = next;
            Persist();
            _ = RetryLater(next, Backoff(next.Attempts), ct);
            return;
        }

        _texts.Write(job.UserId, job.Name, job.Kind, text);
        _search.IndexNotes(job.UserId, _refs.Referrers(job.UserId, job.Name));
        Done(key);
        _logger.LogInformation("Read {Kind} text from {Name} ({Chars} characters)", job.Kind, job.Name, text.Length);
        if (text.Length > 0)
        {
            try { await handler.CompletedAsync(job.UserId, job.Name, text, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "After reading {Kind} text from {Name}", job.Kind, job.Name);
            }
        }
    }

    private bool IsReferenced(string uid, string name) =>
        _state.Snapshot(uid).Any(n => !n.Trashed && _refs.References(n, name));

    private void Done(string key)
    {
        if (_pending.TryRemove(key, out _)) Persist();
    }

    private async Task RetryLater(Job job, TimeSpan delay, CancellationToken ct)
    {
        try { await Task.Delay(delay, ct); }
        catch (OperationCanceledException) { return; } // persisted: resumes on the next start
        _channel.Writer.TryWrite(job);
    }

    // ── Watching media folders (files added outside the app) ──────────────────

    private void EnsureWatching(string uid)
    {
        if (_watchers.ContainsKey(uid)) return;
        var mediaDir = PapyraPaths.UserMediaDir(_config, _contentRoot, uid);
        try
        {
            Directory.CreateDirectory(mediaDir);
            var watcher = new FileSystemWatcher(mediaDir)
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.FileName,
            };
            if (!_watchers.TryAdd(uid, watcher)) { watcher.Dispose(); return; }
            watcher.Created += (_, e) => OnFile(uid, e.Name);
            watcher.Renamed += (_, e) => OnFile(uid, e.Name);
            watcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            _logger.LogDebug(ex, "Not watching media for user {Uid}", uid);
        }
    }

    private void OnFile(string uid, string? name)
    {
        if (string.IsNullOrEmpty(name) || name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) return;
        if (IsReferenced(uid, name)) Enqueue(uid, name);
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    private sealed record Saved(List<Job> Pending, List<Job> Failed);

    private string StatePath => Path.Combine(PapyraPaths.DotPapyra(_config, _contentRoot), "media-jobs.json");

    private void Load()
    {
        try
        {
            if (!File.Exists(StatePath)) return;
            var saved = JsonSerializer.Deserialize<Saved>(File.ReadAllBytes(StatePath));
            foreach (var job in saved?.Pending ?? []) _pending[Key(job.UserId, job.Name, job.Kind)] = job;
            foreach (var job in saved?.Failed ?? []) _failed[Key(job.UserId, job.Name, job.Kind)] = job;
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            _logger.LogWarning(ex, "Ignoring an unreadable media-jobs.json; referenced files are rescanned.");
        }
    }

    private void Persist()
    {
        lock (_persistGate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
                var tmp = StatePath + ".tmp";
                File.WriteAllBytes(tmp, JsonSerializer.SerializeToUtf8Bytes(new Saved(_pending.Values.ToList(), _failed.Values.ToList())));
                File.Move(tmp, StatePath, overwrite: true);
            }
            catch (IOException ex)
            {
                _logger.LogDebug(ex, "Could not save media-jobs.json");
            }
        }
    }

    public override void Dispose()
    {
        foreach (var w in _watchers.Values) w.Dispose();
        base.Dispose();
    }
}
