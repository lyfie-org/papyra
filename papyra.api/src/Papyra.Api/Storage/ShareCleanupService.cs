using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Burn-after-reading housekeeping: hard-deletes share links that have outlived
// their expiry or exhausted their view cap. The public read route already refuses
// to serve an expired/exhausted link (410); this sweep removes the dead rows so
// they don't accumulate. Runs shortly after boot, then every 10 minutes.
// Registered as a hosted service.
public sealed class ShareCleanupService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ShareCleanupService> _logger;

    public ShareCleanupService(IServiceScopeFactory scopes, ILogger<ShareCleanupService> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Small delay so migrations have finished before the first sweep.
        try { await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Interval);
        do
        {
            try { await CleanupOnceAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogWarning(ex, "Share cleanup sweep failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
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
