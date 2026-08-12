using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Housekeeping for BlockGrants whose target no longer exists.
//
// Deleting a note leaves every grant that pointed into it dangling: the inbox
// renders a "no longer available" chip and resolution returns nothing, so the
// rows are harmless but they accumulate forever and keep a stale note title and
// sender handle on record. This sweep removes them.
//
// The one real hazard is sweeping too early. VaultState is a mirror of the
// filesystem that fills in at boot (ColdBootDiffService) and per tenant as
// vaults are watched — an empty bucket means "not loaded yet" just as often as
// it means "no notes". Deleting on that signal would wipe every grant on the
// instance the first time it ran. So a tenant is only ever swept when their
// vault is demonstrably populated; a genuinely empty vault is skipped, which
// leaves a few dead rows rather than risking live ones.
public sealed class GrantCleanupService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly ILogger<GrantCleanupService> _logger;

    public GrantCleanupService(
        IServiceScopeFactory scopes, VaultState state, ILogger<GrantCleanupService> logger)
    {
        _scopes = scopes;
        _state = state;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Long enough for the cold-boot diff to have mirrored the vaults, so the
        // first sweep judges against a populated VaultState.
        try { await Task.Delay(StartupDelay, stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Interval);
        do
        {
            try { await CleanupOnceAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogWarning(ex, "Grant cleanup sweep failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    // Remove grants whose source note is gone, or which no longer carry the
    // anchor they were issued for (the block was deleted or its `^id` rewritten).
    // Returns the count removed. Exposed for direct testing.
    internal async Task<int> CleanupOnceAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var grants = await db.BlockGrants.ToListAsync(ct);
        if (grants.Count == 0) return 0;

        var dead = new List<BlockGrant>();
        foreach (var grant in grants)
        {
            var ownerUid = grant.SourceOwnerId.ToString();

            // Not loaded (or truly empty): can't tell the difference, so leave it.
            if (_state.Count(ownerUid) == 0) continue;

            var path = _state.PathFor(ownerUid, grant.SourceNoteId);
            if (path is null) { dead.Add(grant); continue; }          // note deleted
            if (!_state.TryGet(ownerUid, path, out var note) || note is null) { dead.Add(grant); continue; }

            // A secure note withholds its body everywhere; its anchors are part of
            // that body, so absence here proves nothing. Keep the grant.
            if (note.Secure) continue;

            if (BlockResolver.Resolve(note.Body, grant.BlockId) is null) dead.Add(grant);
        }

        if (dead.Count == 0) return 0;

        db.BlockGrants.RemoveRange(dead);
        await db.SaveChangesAsync(ct);
        _logger.LogInformation("Grant cleanup: removed {Count} dangling block grant(s)", dead.Count);
        return dead.Count;
    }
}
