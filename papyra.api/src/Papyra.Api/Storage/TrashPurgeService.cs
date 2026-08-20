using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Permanently deletes trashed notes once they outlive the retention window
// (see TrashRetention). Runs shortly after boot, then every few hours. The .md is
// the authority, so a purge hard-deletes the file and drops the cache/index rows.
// Registered as a hosted service.
public sealed class TrashPurgeService : PeriodicJob
{
    private static readonly TimeSpan PurgeInterval = TimeSpan.FromHours(6);

    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly WriteRing _writeRing;
    private readonly SearchIndexService _search;
    private readonly ILogger<TrashPurgeService> _logger;

    public TrashPurgeService(
        IServiceScopeFactory scopes,
        VaultState state,
        WriteRing writeRing,
        SearchIndexService search,
        JobRegistry registry,
        ILogger<TrashPurgeService> logger)
        : base(registry)
    {
        _scopes = scopes;
        _state = state;
        _writeRing = writeRing;
        _search = search;
        _logger = logger;
    }

    protected override string JobId => "trash-purge";
    protected override string JobName => "Empty the Trash";
    protected override string JobDescription =>
        "Deletes notes that have been in Trash longer than the time you chose in Settings. "
        + "Once this runs, those notes are gone for good.";
    protected override TimeSpan Interval => PurgeInterval;

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var purged = await PurgeOnceAsync(ct);
        return purged == 0 ? null : $"{purged} note{(purged == 1 ? "" : "s")} deleted for good";
    }

    internal async Task<int> PurgeOnceAsync(CancellationToken ct)
    {
        int days;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            days = await TrashRetention.ReadDays(db, ct);
        }
        if (days < 0) return 0; // keep forever

        var cutoff = DateTime.UtcNow.AddDays(-days);
        var purged = 0;

        foreach (var userId in _state.Users)
        {
            foreach (var note in _state.Snapshot(userId))
            {
                if (!note.Trashed) continue;
                // days == 0 → immediate; else only once the window has elapsed.
                if (days > 0 && !(note.TrashedAt is { } t && t <= cutoff)) continue;

                var path = _state.PathFor(userId, note.Id);
                if (path is null) continue;

                _writeRing.Mark(path);
                if (File.Exists(path)) File.Delete(path);
                _state.Remove(userId, path);
                _search.RemoveNote(userId, note.Id);
                purged++;
            }
        }

        if (purged > 0) _logger.LogInformation("Trash purge: permanently deleted {Count} note(s)", purged);
        return purged;
    }
}
