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
public sealed class GrantCleanupService : PeriodicJob
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromHours(6);

    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly ILogger<GrantCleanupService> _logger;

    public GrantCleanupService(
        IServiceScopeFactory scopes, VaultState state, JobRegistry registry,
        ILogger<GrantCleanupService> logger)
        : base(registry)
    {
        _scopes = scopes;
        _state = state;
        _logger = logger;
    }

    protected override string JobId => "grant-cleanup";
    protected override string JobName => "Tidy up mentions of deleted notes";
    protected override string JobDescription =>
        "When a note is deleted, the inbox entries pointing into it stop working. "
        + "This clears those dead entries so nobody's inbox fills with them.";
    protected override TimeSpan Interval => SweepInterval;
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(2);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var removed = await CleanupOnceAsync(ct);
        return removed == 0 ? null : $"{removed} dead inbox entr{(removed == 1 ? "y" : "ies")} cleared";
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

            // Anchored grants are matched by their `^id`; a grant delivered from a
            // block that never carried one is matched by the line's own text. Both
            // are dangling once the block they point at is gone from the note.
            var resolved = grant.BlockId.Length > 0
                ? BlockResolver.Resolve(note.Body, grant.BlockId)
                : BlockResolver.ResolveLine(note.Body, grant.BlockText);
            if (resolved is null) dead.Add(grant);
        }

        if (dead.Count == 0) return 0;

        db.BlockGrants.RemoveRange(dead);
        await db.SaveChangesAsync(ct);
        _logger.LogInformation("Grant cleanup: removed {Count} dangling block grant(s)", dead.Count);
        return dead.Count;
    }
}
