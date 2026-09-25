using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// Version-history engine: timestamped copies of a note's .md so a truncation,
// bad sync merge, or fat-fingered edit can be rolled back. Snapshots live under
// the user's hidden .papyra dir (never the watched vault) and are throttled — at
// most one per note every MinInterval — so the 1.5s editor auto-save can't bury
// disk in micro-versions. Anything older than MaxAge is pruned on each capture.
//
// A version is only worth keeping if it reads differently. Every write used to
// archive the prior file, so a pin/colour/tag flip, a save that only stamped
// hidden `^id` anchors, or a re-save of unchanged text each produced another
// "version" identical to its neighbour — the history filled with duplicates the
// person had to click through to find a real change. Versions are therefore
// compared by content fingerprint (title + body, anchors and whitespace noise
// removed): capture skips a copy identical to the newest one, and the listing
// collapses runs of identical versions and hides any identical to the live note.
// Registered as a singleton; takes already-resolved (path-jailed) directories.
public sealed partial class SnapshotService
{
    public static readonly TimeSpan DefaultMinInterval = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    private readonly ILogger<SnapshotService> _logger;
    private readonly MarkdownStorageService _storage;

    // Fingerprints keyed by path, valid while the file's size and mtime hold —
    // snapshots are immutable once written, so listing re-reads almost nothing.
    private readonly ConcurrentDictionary<string, (long Length, DateTime Mtime, string Hash)> _fingerprints = new();

    public TimeSpan MinInterval { get; }

    public SnapshotService(ILogger<SnapshotService> logger, MarkdownStorageService storage, IConfiguration? config = null)
    {
        _logger = logger;
        _storage = storage;
        var seconds = config?.GetValue<double?>("Papyra:SnapshotMinIntervalSeconds");
        MinInterval = seconds is { } s && s >= 0 ? TimeSpan.FromSeconds(s) : DefaultMinInterval;
    }

    // One archived version: Id is the file stem (UTC ticks), TimestampUtc its time.
    public readonly record struct Snapshot(string Id, DateTime TimestampUtc);

    // Copy the current on-disk note into its snapshot dir. Captures the state
    // *before* a write overwrites it, so history is the prior saved revision.
    //
    // Skipped when the newest snapshot already holds the same content, and — unless
    // `force` — when that snapshot is younger than MinInterval (throttle). A restore
    // forces: it must always leave the version it replaces recoverable, or "undo the
    // restore" silently fails whenever the last snapshot was a few minutes old.
    //
    // Returns the id of the snapshot that now holds the file's content (the new one,
    // or the identical newest one), or null when nothing holds it (throttled, no
    // source, or the capture failed). Best-effort: never throws, never blocks the
    // actual note write.
    public async Task<string?> CaptureAsync(string noteSnapshotDir, string sourcePath, CancellationToken ct = default, bool force = false)
    {
        try
        {
            if (!File.Exists(sourcePath)) return null;

            var newest = NewestPath(noteSnapshotDir);
            if (newest is not null)
            {
                var sourceHash = FingerprintOf(sourcePath, cache: false);
                if (sourceHash is not null && sourceHash == FingerprintOf(newest))
                {
                    Prune(noteSnapshotDir);
                    return Path.GetFileNameWithoutExtension(newest);
                }

                if (!force && DateTime.UtcNow - TimeOf(newest) < MinInterval)
                {
                    Prune(noteSnapshotDir);
                    return null;
                }
            }

            Directory.CreateDirectory(noteSnapshotDir);
            var ticks = DateTime.UtcNow.Ticks;
            // Ids are ticks; two forced captures in one tick must not overwrite.
            while (File.Exists(Path.Combine(noteSnapshotDir, $"{ticks}.md"))) ticks++;
            var dest = Path.Combine(noteSnapshotDir, $"{ticks}.md");
            await AtomicCopyAsync(sourcePath, dest, ct);
            Prune(noteSnapshotDir);
            return ticks.ToString();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Snapshot capture failed for {Dir}", noteSnapshotDir);
            return null;
        }
    }

    // Newest-first list of a note's distinct versions (id + timestamp only; no
    // bodies). A run of consecutive identical versions shows once (its newest), and
    // versions identical to the live note at `currentPath` are left out — restoring
    // one would change nothing. Non-adjacent repeats (A → B → A) are kept: they are
    // different points in time.
    public IReadOnlyList<Snapshot> List(string noteSnapshotDir, string? currentPath = null)
    {
        if (!Directory.Exists(noteSnapshotDir)) return [];

        var all = Directory.EnumerateFiles(noteSnapshotDir, "*.md")
            .Select(p => (Path: p, Stem: Path.GetFileNameWithoutExtension(p)))
            .Where(x => long.TryParse(x.Stem, out _))
            .OrderByDescending(x => long.Parse(x.Stem))
            .ToList();

        var current = currentPath is not null && File.Exists(currentPath)
            ? FingerprintOf(currentPath, cache: false)
            : null;

        var result = new List<Snapshot>(all.Count);
        string? previous = null;
        foreach (var (path, stem) in all)
        {
            var hash = FingerprintOf(path);
            if (hash is not null && (hash == previous || hash == current))
            {
                previous = hash;
                continue;
            }
            previous = hash;
            result.Add(new Snapshot(stem, new DateTime(long.Parse(stem), DateTimeKind.Utc)));
        }
        return result;
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

    // ── Content fingerprint ──────────────────────────────────────────────────

    /// <summary>
    /// What a person would see differ between two versions: the title and the body,
    /// minus the editor's invisible `^id` block anchors, line-ending style and
    /// trailing whitespace. Frontmatter bookkeeping (pin, colour, tags, foreign
    /// keys) is not content — two versions that differ only there read identically
    /// in the history, so they count as one.
    /// </summary>
    public static string Fingerprint(string title, string body)
    {
        var text = body.Replace("\r\n", "\n").Replace('\r', '\n');
        text = AnchorToken().Replace(text, string.Empty);
        text = TrailingSpace().Replace(text, string.Empty).Trim('\n');
        var bytes = Encoding.UTF8.GetBytes($"{title.Trim()}\n\u0000\n{text}");
        return Convert.ToHexString(SHA256.HashData(bytes));
    }

    // Same token BlockResolver/PlainText strip: `^id` at line start or after a space.
    [GeneratedRegex(@"(?<=^|[ \t])\^[A-Za-z0-9][A-Za-z0-9_-]*(?=[ \t]|$)", RegexOptions.Multiline)]
    private static partial Regex AnchorToken();

    [GeneratedRegex(@"[ \t]+$", RegexOptions.Multiline)]
    private static partial Regex TrailingSpace();

    private string? FingerprintOf(string path, bool cache = true)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return null;
            if (cache && _fingerprints.TryGetValue(path, out var hit)
                && hit.Length == info.Length && hit.Mtime == info.LastWriteTimeUtc)
                return hit.Hash;

            var note = _storage.Deserialize(File.ReadAllText(path));
            var hash = Fingerprint(note.Title, note.Body);
            if (cache) _fingerprints[path] = (info.Length, info.LastWriteTimeUtc, hash);
            return hash;
        }
        catch (Exception ex)
        {
            // Unreadable → never treated as a duplicate of anything; it stays listed.
            _logger.LogDebug(ex, "Could not fingerprint {Path}", path);
            return null;
        }
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

    private static DateTime TimeOf(string snapshotPath)
        => new(long.Parse(Path.GetFileNameWithoutExtension(snapshotPath)), DateTimeKind.Utc);

    private static string? NewestPath(string noteSnapshotDir)
    {
        if (!Directory.Exists(noteSnapshotDir)) return null;
        long? max = null;
        string? newest = null;
        foreach (var p in Directory.EnumerateFiles(noteSnapshotDir, "*.md"))
            if (long.TryParse(Path.GetFileNameWithoutExtension(p), out var ticks) && (max is null || ticks > max))
            {
                max = ticks;
                newest = p;
            }
        return newest;
    }

    private void Prune(string noteSnapshotDir)
    {
        if (!Directory.Exists(noteSnapshotDir)) return;
        var cutoff = DateTime.UtcNow - MaxAge;
        foreach (var p in Directory.EnumerateFiles(noteSnapshotDir, "*.md"))
        {
            if (!long.TryParse(Path.GetFileNameWithoutExtension(p), out var ticks)) continue;
            if (new DateTime(ticks, DateTimeKind.Utc) >= cutoff) continue;
            try
            {
                File.Delete(p);
                _fingerprints.TryRemove(p, out _);
            }
            catch (IOException ex) { _logger.LogDebug(ex, "Could not prune snapshot {Path}", p); }
        }
    }
}
