namespace Papyra.Api.Storage;

// Version-history engine: timestamped copies of a note's .md so a truncation,
// bad sync merge, or fat-fingered edit can be rolled back. Snapshots live under
// the user's hidden .papyra dir (never the watched vault) and are throttled — at
// most one per note every MinInterval — so the 1.5s editor auto-save can't bury
// disk in micro-versions. Anything older than MaxAge is pruned on each capture.
// Registered as a singleton; takes already-resolved (path-jailed) directories.
public sealed class SnapshotService
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    private readonly ILogger<SnapshotService> _logger;

    public SnapshotService(ILogger<SnapshotService> logger) => _logger = logger;

    // One archived version: Id is the file stem (UTC ticks), TimestampUtc its time.
    public readonly record struct Snapshot(string Id, DateTime TimestampUtc);

    // Copy the current on-disk note into its snapshot dir, unless the newest
    // existing snapshot is younger than MinInterval (throttle). Captures the state
    // *before* a write overwrites it, so history is the prior saved revision.
    // Best-effort: a snapshot failure must never block the actual note write.
    public async Task CaptureAsync(string noteSnapshotDir, string sourcePath, CancellationToken ct = default)
    {
        try
        {
            if (!File.Exists(sourcePath)) return;

            var newest = Newest(noteSnapshotDir);
            if (newest is { } t && DateTime.UtcNow - t < MinInterval)
            {
                Prune(noteSnapshotDir);
                return;
            }

            Directory.CreateDirectory(noteSnapshotDir);
            var dest = Path.Combine(noteSnapshotDir, $"{DateTime.UtcNow.Ticks}.md");
            await AtomicCopyAsync(sourcePath, dest, ct);
            Prune(noteSnapshotDir);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Snapshot capture failed for {Dir}", noteSnapshotDir);
        }
    }

    // Newest-first list of a note's snapshots (id + timestamp only; no bodies).
    public IReadOnlyList<Snapshot> List(string noteSnapshotDir)
    {
        if (!Directory.Exists(noteSnapshotDir)) return [];
        return Directory.EnumerateFiles(noteSnapshotDir, "*.md")
            .Select(p => Path.GetFileNameWithoutExtension(p))
            .Where(stem => long.TryParse(stem, out _))
            .Select(stem => new Snapshot(stem, new DateTime(long.Parse(stem), DateTimeKind.Utc)))
            .OrderByDescending(s => s.TimestampUtc)
            .ToList();
    }

    // Atomically replace `notePath` with the snapshot's bytes (tmp → fsync →
    // replace), preserving the snapshot verbatim (foreign YAML keys included).
    public async Task RestoreAsync(string snapshotPath, string notePath, CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(notePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var tmp = Path.Combine(dir ?? ".", $"{Guid.NewGuid():N}.tmp");
        await AtomicCopyAsync(snapshotPath, tmp, ct, fsyncDest: false);

        if (File.Exists(notePath))
            File.Replace(tmp, notePath, destinationBackupFileName: null);
        else
            File.Move(tmp, notePath, overwrite: true);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private static async Task AtomicCopyAsync(string src, string dest, CancellationToken ct, bool fsyncDest = true)
    {
        if (fsyncDest)
        {
            // Snapshot writes go straight to their final name via a sibling tmp so a
            // crash mid-copy never leaves a 0-byte version.
            var dir = Path.GetDirectoryName(dest) ?? ".";
            var tmp = Path.Combine(dir, $"{Guid.NewGuid():N}.tmp");
            await CopyBytesAsync(src, tmp, ct);
            File.Move(tmp, dest, overwrite: true);
            return;
        }

        await CopyBytesAsync(src, dest, ct);
    }

    private static async Task CopyBytesAsync(string src, string dest, CancellationToken ct)
    {
        var bytes = await File.ReadAllBytesAsync(src, ct);
        await using var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None);
        await fs.WriteAsync(bytes, ct);
        await fs.FlushAsync(ct);
        fs.Flush(flushToDisk: true); // durability before the replace
    }

    private static DateTime? Newest(string noteSnapshotDir)
    {
        if (!Directory.Exists(noteSnapshotDir)) return null;
        long? max = null;
        foreach (var p in Directory.EnumerateFiles(noteSnapshotDir, "*.md"))
            if (long.TryParse(Path.GetFileNameWithoutExtension(p), out var ticks) && (max is null || ticks > max))
                max = ticks;
        return max is null ? null : new DateTime(max.Value, DateTimeKind.Utc);
    }

    private void Prune(string noteSnapshotDir)
    {
        if (!Directory.Exists(noteSnapshotDir)) return;
        var cutoff = DateTime.UtcNow - MaxAge;
        foreach (var p in Directory.EnumerateFiles(noteSnapshotDir, "*.md"))
        {
            if (!long.TryParse(Path.GetFileNameWithoutExtension(p), out var ticks)) continue;
            if (new DateTime(ticks, DateTimeKind.Utc) >= cutoff) continue;
            try { File.Delete(p); }
            catch (IOException ex) { _logger.LogDebug(ex, "Could not prune snapshot {Path}", p); }
        }
    }
}
