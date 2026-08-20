using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Burn-after-reading housekeeping: hard-deletes share links that have outlived
// their expiry or exhausted their view cap. The public read route already refuses
// to serve an expired/exhausted link (410); this sweep removes the dead rows so
// they don't accumulate. Runs shortly after boot, then every 10 minutes.
// Registered as a hosted service.
public sealed class ShareCleanupService : PeriodicJob
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ShareCleanupService> _logger;

    public ShareCleanupService(
        IServiceScopeFactory scopes, JobRegistry registry, ILogger<ShareCleanupService> logger)
        : base(registry)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override string JobId => "share-cleanup";
    protected override string JobName => "Tidy up finished share links";
    protected override string JobDescription =>
        "Removes share links that have expired or been opened as many times as you allowed. "
        + "They already stop working the moment they run out; this clears the leftovers.";
    protected override TimeSpan Interval => TimeSpan.FromMinutes(10);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var removed = await CleanupOnceAsync(ct);
        return removed == 0 ? null : $"{removed} finished link{(removed == 1 ? "" : "s")} cleared";
    }

    // Delete every share past its expiry or at/over its view cap. Returns the count
    // removed. Exposed for direct testing.
    internal async Task<int> CleanupOnceAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var removed = await db.Shares
            .Where(s => (s.ExpiresUtc != null && s.ExpiresUtc < now)
                        || (s.MaxViews != null && s.ViewCount >= s.MaxViews))
            .ExecuteDeleteAsync(ct);

        if (removed > 0)
            _logger.LogInformation("Share cleanup: hard-deleted {Count} expired/exhausted share(s)", removed);
        return removed;
    }
}
