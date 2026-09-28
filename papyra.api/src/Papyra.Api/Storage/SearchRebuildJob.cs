namespace Papyra.Api.Storage;

/// <summary>
/// Rebuilds search for every account once a day, from the files on disk.
///
/// Search already follows each note as it changes (the "Keep search up to date"
/// job) and every import rebuilds its account when it finishes. This is the
/// safety net under both: an edit the watcher missed while the server was down,
/// a file synced in by another tool, an index left behind by a crash — by the
/// next day, search matches the notes again without anyone asking. "Run now" on
/// the Jobs screen is the same sweep.
/// </summary>
public sealed class SearchRebuildJob : PeriodicJob
{
    private readonly SearchRebuilder _rebuilder;

    public SearchRebuildJob(SearchRebuilder rebuilder, JobRegistry registry) : base(registry)
    {
        _rebuilder = rebuilder;
    }

    protected override string JobId => "search-rebuild";
    protected override string JobName => "Rebuild search";
    protected override string JobDescription =>
        "Re-reads every note from disk and rebuilds search from scratch, so nothing goes missing from "
        + "results. Safe any time — it only rewrites what search uses, never your notes. Also runs "
        + "after every import.";
    protected override TimeSpan Interval => TimeSpan.FromHours(24);
    // Not in the busy first minutes after boot: the cold-boot scan is already
    // reconciling the vault then, and search is fresh from it.
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(10);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var n = await _rebuilder.RebuildAllAsync(ct);
        return $"{n} note{(n == 1 ? "" : "s")} indexed";
    }
}
