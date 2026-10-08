using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Security;

namespace Papyra.Api.Storage;

/// <summary>An exception attached to a log entry: type, scrubbed message, frames.</summary>
public sealed record ActivityLogException(string Type, string Message, string Stack);

/// <summary>
/// One line in Settings → Logs. Everything in it has been through
/// <see cref="LogScrubber"/>: it says what happened, never to whom or to what.
/// </summary>
public sealed record ActivityLogEntry(
    string Id,
    DateTime TimeUtc,
    string Level,      // "error", "warning" or "info"
    string Source,     // a class name ("TrashPurgeService"), or "Browser"
    string Message,
    ActivityLogException? Exception);

/// <summary>
/// How long the instance's log is kept, chosen in Settings → Logs. Hours, so a
/// day and a month are the same kind of number.
/// </summary>
public static class LogRetention
{
    public const string Key = "logs.retentionHours";
    public const int DefaultHours = 168;
    public static readonly int[] Allowed = [24, 72, 168, 336, 720];

    public static async Task<int> ReadHours(AppDbContext db, CancellationToken ct = default)
    {
        var row = await db.Settings.FirstOrDefaultAsync(s => s.Key == Key, ct);
        return row?.Value is { } v && int.TryParse(v, out var h) && Allowed.Contains(h) ? h : DefaultHours;
    }
}

/// <summary>
/// The instance's rolling log, kept for the admin's Logs screen.
///
/// One JSON line per entry, one file per hour under <c>.papyra/logs/</c>
/// (<c>20261008-15.jsonl</c>), so expiring an hour is deleting a file and the
/// log can never grow past what the retention allows. Writes go through a
/// bounded queue drained by one background writer: logging never waits on the
/// disk, and a flood drops entries rather than memory. A full or read-only disk
/// loses log lines, never the request that produced them.
/// </summary>
public sealed class ActivityLogStore : IDisposable
{
    /// <summary>Per hour; past this the rest of the hour is dropped (with one marker line).</summary>
    public const int MaxPerHour = 5_000;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _dir;
    private readonly Channel<ActivityLogEntry> _queue = Channel.CreateBounded<ActivityLogEntry>(
        new BoundedChannelOptions(10_000) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
    private readonly Lock _files = new();
    private readonly Task _writer;
    private int _pending;
    private string? _hourKey;
    private int _hourCount;

    public ActivityLogStore(IConfiguration config, IHostEnvironment env)
        : this(Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "logs")) { }

    public ActivityLogStore(string dir)
    {
        _dir = dir;
        _writer = Task.Run(WriteLoopAsync);
    }

    public string Folder => _dir;

    public static string NewId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant();

    public void Add(ActivityLogEntry entry)
    {
        Interlocked.Increment(ref _pending);
        if (!_queue.Writer.TryWrite(entry)) Interlocked.Decrement(ref _pending);
    }

    /// <summary>Waits (briefly) for queued entries to reach the disk, so a read sees them.</summary>
    public async Task FlushAsync(TimeSpan? timeout = null)
    {
        var until = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(2));
        while (Volatile.Read(ref _pending) > 0 && DateTime.UtcNow < until)
            await Task.Delay(10);
    }

    private async Task WriteLoopAsync()
    {
        var reader = _queue.Reader;
        while (await reader.WaitToReadAsync())
        {
            var batch = new List<ActivityLogEntry>();
            while (batch.Count < 500 && reader.TryRead(out var entry)) batch.Add(entry);
            try
            {
                lock (_files) WriteBatch(batch);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Nowhere to put it. The log is a convenience; the app carries on.
            }
            finally
            {
                Interlocked.Add(ref _pending, -batch.Count);
            }
        }
    }

    private void WriteBatch(List<ActivityLogEntry> batch)
    {
        System.IO.Directory.CreateDirectory(_dir);
        StreamWriter? writer = null;
        string? open = null;
        try
        {
            foreach (var entry in batch)
            {
                var key = HourKey(entry.TimeUtc);
                if (key != _hourKey)
                {
                    _hourKey = key;
                    var existing = PathFor(key);
                    _hourCount = File.Exists(existing) ? File.ReadLines(existing).Count() : 0;
                }
                if (_hourCount > MaxPerHour) continue;

                var line = _hourCount == MaxPerHour
                    ? new ActivityLogEntry(NewId(), entry.TimeUtc, "warning", "Logs",
                        $"More than {MaxPerHour} entries this hour; the rest of the hour was not kept.", null)
                    : entry;
                _hourCount++;

                if (open != key)
                {
                    writer?.Dispose();
                    var stream = new FileStream(PathFor(key), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                    writer = new StreamWriter(stream, new UTF8Encoding(false));
                    open = key;
                }
                writer!.WriteLine(JsonSerializer.Serialize(line, Json));
            }
        }
        finally
        {
            writer?.Flush();
            writer?.Dispose();
        }
    }

    /// <summary>
    /// Entries newest first, from <paramref name="sinceUtc"/> on and older than
    /// <paramref name="beforeUtc"/> when given (the "Load more" cursor).
    /// </summary>
    public async Task<(IReadOnlyList<ActivityLogEntry> Entries, bool HasMore)> ReadAsync(
        DateTime sinceUtc, string? level, DateTime? beforeUtc, int limit, CancellationToken ct = default)
    {
        await FlushAsync();
        var result = new List<ActivityLogEntry>();
        if (!System.IO.Directory.Exists(_dir)) return (result, false);

        var sinceKey = HourKey(sinceUtc);
        var beforeKey = beforeUtc is { } b ? HourKey(b) : null;
        var files = System.IO.Directory.GetFiles(_dir, "*.jsonl")
            .Select(Path.GetFileNameWithoutExtension)
            .OfType<string>()
            .Where(k => string.CompareOrdinal(k, sinceKey) >= 0 && (beforeKey is null || string.CompareOrdinal(k, beforeKey) <= 0))
            .OrderByDescending(k => k, StringComparer.Ordinal);

        foreach (var key in files)
        {
            ct.ThrowIfCancellationRequested();
            List<string> lines;
            try
            {
                using var stream = new FileStream(PathFor(key), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var text = new StreamReader(stream);
                lines = [];
                while (await text.ReadLineAsync(ct) is { } line) lines.Add(line);
            }
            catch (FileNotFoundException) { continue; }

            for (var i = lines.Count - 1; i >= 0; i--)
            {
                ActivityLogEntry? entry;
                try { entry = JsonSerializer.Deserialize<ActivityLogEntry>(lines[i], Json); }
                catch (JsonException) { continue; } // a line cut short by a crash
                if (entry is null || entry.TimeUtc < sinceUtc) continue;
                if (beforeUtc is { } before && entry.TimeUtc >= before) continue;
                if (level is not null && entry.Level != level) continue;
                result.Add(entry);
                if (result.Count > limit) return (result.Take(limit).ToList(), true);
            }
        }
        return (result, false);
    }

    /// <summary>Deletes every hour that ended before <paramref name="cutoffUtc"/>. Returns how many.</summary>
    public int Sweep(DateTime cutoffUtc)
    {
        if (!System.IO.Directory.Exists(_dir)) return 0;
        var deleted = 0;
        lock (_files)
        {
            foreach (var path in System.IO.Directory.GetFiles(_dir, "*.jsonl"))
            {
                var key = Path.GetFileNameWithoutExtension(path);
                if (!TryParseHour(key, out var start) || start.AddHours(1) > cutoffUtc) continue;
                try { File.Delete(path); deleted++; }
                catch (IOException) { /* in use; next sweep */ }
            }
            _hourKey = null;
        }
        return deleted;
    }

    /// <summary>Empties the log.</summary>
    public void Clear()
    {
        lock (_files)
        {
            if (System.IO.Directory.Exists(_dir))
                foreach (var path in System.IO.Directory.GetFiles(_dir, "*.jsonl"))
                    try { File.Delete(path); } catch (IOException) { }
            _hourKey = null;
        }
    }

    private string PathFor(string key) => Path.Combine(_dir, key + ".jsonl");

    private static string HourKey(DateTime utc) => utc.ToUniversalTime().ToString("yyyyMMdd-HH", System.Globalization.CultureInfo.InvariantCulture);

    private static bool TryParseHour(string key, out DateTime start) =>
        DateTime.TryParseExact(key, "yyyyMMdd-HH", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out start);

    public void Dispose()
    {
        _queue.Writer.TryComplete();
        try { _writer.Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { }
    }
}

/// <summary>
/// Feeds <see cref="ActivityLogStore"/> from the ordinary <c>ILogger</c> calls.
/// Papyra's own categories are kept from Information up (what it did: a job
/// ran, a backup finished); the framework's from Warning up (what went wrong).
/// Every message is rendered through <see cref="LogScrubber"/> before it is kept.
/// </summary>
public sealed class ActivityLoggerProvider(ActivityLogStore store) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new ActivityLogger(categoryName, store);

    public void Dispose() { }

    private sealed class ActivityLogger(string category, ActivityLogStore store) : ILogger
    {
        private readonly LogLevel _min = category.StartsWith("Papyra", StringComparison.Ordinal)
            ? LogLevel.Information
            : LogLevel.Warning;

        private readonly string _source = SourceOf(category);

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && logLevel >= _min;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            string message;
            ActivityLogException? error = null;
            try
            {
                message = LogScrubber.Render(state, exception, formatter);
                if (exception is not null)
                {
                    var (type, text, stack) = LogScrubber.Describe(exception);
                    error = new ActivityLogException(type, text, stack);
                }
            }
            catch
            {
                // Never let the log's own bookkeeping break the call that logged.
                return;
            }
            var level = logLevel >= LogLevel.Error ? "error" : logLevel == LogLevel.Warning ? "warning" : "info";
            store.Add(new ActivityLogEntry(ActivityLogStore.NewId(), DateTime.UtcNow, level, _source, message, error));
        }

        // "Papyra.Api.Storage.TrashPurgeService" → "TrashPurgeService"; the
        // generic-type tail and nested "+" are noise on screen.
        private static string SourceOf(string category)
        {
            var name = category.Split('`')[0];
            var dot = name.LastIndexOf('.');
            name = dot >= 0 && dot < name.Length - 1 ? name[(dot + 1)..] : name;
            return name.Replace('+', '.');
        }
    }
}

/// <summary>Expires log hours older than the retention chosen in Settings → Logs.</summary>
public sealed class LogCleanupJob(IServiceScopeFactory scopes, ActivityLogStore store, JobRegistry registry)
    : PeriodicJob(registry)
{
    protected override string JobId => "log-cleanup";
    protected override string JobName => "Trim the logs";
    protected override string JobDescription => "Deletes log entries older than the time chosen in Settings → Logs.";
    protected override TimeSpan Interval => TimeSpan.FromHours(1);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        int hours;
        using (var scope = scopes.CreateScope())
            hours = await LogRetention.ReadHours(scope.ServiceProvider.GetRequiredService<AppDbContext>(), ct);
        var deleted = store.Sweep(DateTime.UtcNow.AddHours(-hours));
        return deleted == 0 ? null : $"{deleted} hour{(deleted == 1 ? "" : "s")} of logs deleted";
    }
}
