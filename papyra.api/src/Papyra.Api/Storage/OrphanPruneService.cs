using System.Globalization;
using System.Text.Json;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Nightly housekeeping for attachments, per tenant.
//
// A file in the media dir that nothing references — no note (trashed ones
// included, they can come back), no saved version of a note, no conflict copy —
// is moved to users/{uid}/.trash/media/{yyyyMMdd}/, never hard-deleted, and only
// once it has sat unreferenced past a grace period: a picture pasted into a note
// that hasn't saved yet is not an orphan. Moved files are purged after the
// user's trash-retention setting (default 30 days). Names match
// case-insensitively (Obsidian embeds do), and the references come from the
// cached MediaReferences index, so a sweep is O(files + notes), not their product.
public sealed class OrphanPruneService : PeriodicJob
{
    private static readonly TimeSpan PruneInterval = TimeSpan.FromHours(24);
    private static readonly TimeSpan StaleUpload = TimeSpan.FromHours(1);
    public static readonly TimeSpan Grace = TimeSpan.FromDays(7);
    private const string DayFormat = "yyyyMMdd";

    private readonly VaultState _state;
    private readonly MediaReferences _refs;
    private readonly MediaMetaStore _meta;
    private readonly IServiceScopeFactory? _scopes;
    private readonly IConfiguration _config;
    private readonly string _contentRoot;
    private readonly ILogger<OrphanPruneService> _logger;

    public OrphanPruneService(
        VaultState state,
        MediaReferences refs,
        MediaMetaStore meta,
        IConfiguration config,
        IHostEnvironment env,
        JobRegistry registry,
        ILogger<OrphanPruneService> logger,
        IServiceScopeFactory? scopes = null)
        : base(registry)
    {
        _state = state;
        _refs = refs;
        _meta = meta;
        _scopes = scopes;
        _config = config;
        _contentRoot = env.ContentRootPath;
        _logger = logger;
    }

    protected override string JobId => "orphan-prune";
    protected override string JobName => "Move unused pictures to Trash";
    protected override string JobDescription =>
        "Looks for images and files that no note — and no saved version of a note — has referred to "
        + "for a week, and moves them to Trash. Nothing is deleted outright until your trash retention "
        + "runs out, so a mistake is always recoverable.";
    protected override TimeSpan Interval => PruneInterval;

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var retention = await RetentionDaysAsync(ct);
        var (moved, purged) = PruneOnce(retention);
        if (moved == 0 && purged == 0) return null;
        var parts = new List<string>();
        if (moved > 0) parts.Add($"{moved} unused file{(moved == 1 ? "" : "s")} moved to Trash");
        if (purged > 0) parts.Add($"{purged} expired from Trash");
        return string.Join("; ", parts);
    }

    // On-demand sweep for the housekeeping endpoint. Same work as the nightly run.
    public int PruneNow() => PruneOnce(TrashRetention.DefaultDays).Moved;

    // Sweep every tracked tenant's media dir.
    internal (int Moved, int Purged) PruneOnce(int retentionDays = TrashRetention.DefaultDays, DateTime? nowUtc = null)
    {
        var now = nowUtc ?? DateTime.UtcNow;
        int moved = 0, purged = 0;
        foreach (var userId in _state.Users)
        {
            try
            {
                moved += PruneUser(userId, now);
                purged += PurgeUser(userId, retentionDays, now);
                SweepDerived(userId);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Orphan prune skipped part of user {User}", userId);
            }
        }

        if (moved > 0) _logger.LogInformation("Orphan prune: moved {Count} unreferenced media file(s) to trash", moved);
        if (purged > 0) _logger.LogInformation("Orphan prune: purged {Count} expired media file(s) from trash", purged);
        return (moved, purged);
    }

    private int PruneUser(string userId, DateTime now)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _contentRoot, userId);
        if (!Directory.Exists(mediaDir)) return 0;

        var referenced = _refs.AllReferenced(userId);
        var dayDir = Path.Combine(MediaTrashDir(userId), now.ToString(DayFormat, CultureInfo.InvariantCulture));
        var moved = 0;

        foreach (var path in Directory.EnumerateFiles(mediaDir))
        {
            var name = Path.GetFileName(path);
            // An upload in flight streams into a .tmp before its atomic move —
            // never touch a fresh one. A stale one is the leftover of a crash
            // mid-upload: it is nobody's file, so it is simply removed.
            if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
            {
                if (File.GetLastWriteTimeUtc(path) < now - StaleUpload)
                    try { File.Delete(path); } catch (IOException) { }
                continue;
            }
            if (referenced.Contains(name)) continue;

            // Grace: a fresh upload may belong to a note that hasn't saved yet.
            var info = new FileInfo(path);
            var touched = info.LastWriteTimeUtc > info.CreationTimeUtc ? info.LastWriteTimeUtc : info.CreationTimeUtc;
            if (touched > now - Grace) continue;

            Directory.CreateDirectory(dayDir);
            var dest = Path.Combine(dayDir, name);
            if (File.Exists(dest)) // collision-safe: never clobber an earlier trash entry
                dest = Path.Combine(dayDir, $"{Path.GetFileNameWithoutExtension(name)}.{Guid.NewGuid():N}{Path.GetExtension(name)}");
            File.Move(path, dest);
            _meta.MoveDerivedTo(userId, name, dayDir);
            moved++;
        }
        return moved;
    }

    // Trash days older than the retention window go for good. -1 keeps forever.
    private int PurgeUser(string userId, int retentionDays, DateTime now)
    {
        if (retentionDays < 0) return 0;
        var root = MediaTrashDir(userId);
        if (!Directory.Exists(root)) return 0;
        var purged = 0;
        foreach (var day in Directory.EnumerateDirectories(root))
        {
            if (!DateTime.TryParseExact(Path.GetFileName(day), DayFormat, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)) continue;
            if (date.AddDays(retentionDays + 1) > now) continue;
            purged += Directory.EnumerateFiles(day).Count(f => !f.EndsWith(".meta.json", StringComparison.Ordinal)
                && !f.Contains(".poster.", StringComparison.Ordinal));
            Directory.Delete(day, recursive: true);
        }
        return purged;
    }

    // Derived state whose attachment is gone: stale meta files, and thumbnails no
    // remaining attachment uses.
    private void SweepDerived(string userId)
    {
        var derived = _meta.DerivedDir(userId);
        if (!Directory.Exists(derived)) return;
        var mediaDir = PapyraPaths.UserMediaDir(_config, _contentRoot, userId);
        var live = new HashSet<string>(StringComparer.Ordinal);
        foreach (var metaFile in Directory.EnumerateFiles(derived, "*.meta.json"))
        {
            var name = Path.GetFileName(metaFile)[..^".meta.json".Length];
            if (!File.Exists(Path.Combine(mediaDir, name)))
            {
                try { File.Delete(metaFile); } catch (IOException) { }
                continue;
            }
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(metaFile));
                if (doc.RootElement.TryGetProperty("version", out var v) && v.GetString() is { } version) live.Add(version);
            }
            catch (Exception ex) when (ex is IOException or JsonException) { }
        }
        _meta.SweepThumbnails(userId, live);
    }

    private string MediaTrashDir(string userId) =>
        Path.Combine(PapyraPaths.UserTrashDir(_config, _contentRoot, userId), "media");

    private async Task<int> RetentionDaysAsync(CancellationToken ct)
    {
        if (_scopes is null) return TrashRetention.DefaultDays;
        try
        {
            using var scope = _scopes.CreateScope();
            return await TrashRetention.ReadDays(scope.ServiceProvider.GetRequiredService<AppDbContext>(), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return TrashRetention.DefaultDays;
        }
    }
}
