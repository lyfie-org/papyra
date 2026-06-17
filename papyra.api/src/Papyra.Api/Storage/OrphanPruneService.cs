namespace Papyra.Api.Storage;

// Nightly housekeeping: per tenant, any file in that user's media dir that no live
// note of theirs references (via ![[filename]] or a bare mention in its body) is
// moved to their .trash — never hard-deleted, so a mistaken prune is always
// recoverable. Drives off VaultState, the in-memory mirror of the vault. Registered
// as a hosted service.
public sealed class OrphanPruneService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    private readonly VaultState _state;
    private readonly IConfiguration _config;
    private readonly string _contentRoot;
    private readonly ILogger<OrphanPruneService> _logger;

    public OrphanPruneService(
        VaultState state,
        IConfiguration config,
        IHostEnvironment env,
        ILogger<OrphanPruneService> logger)
    {
        _state = state;
        _config = config;
        _contentRoot = env.ContentRootPath;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { PruneOnce(); }
            catch (Exception ex) { _logger.LogWarning(ex, "Orphan prune sweep failed"); }
        }
    }

    // Sweep every tracked tenant's media dir. Returns the total count moved.
    internal int PruneOnce()
    {
        var moved = 0;
        foreach (var userId in _state.Users)
            moved += PruneUser(userId);

        if (moved > 0) _logger.LogInformation("Orphan prune: moved {Count} unreferenced media file(s) to .trash", moved);
        return moved;
    }

    // Move one tenant's unreferenced media files to their .trash.
    private int PruneUser(string userId)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _contentRoot, userId);
        if (!Directory.Exists(mediaDir)) return 0;

        var trashDir = PapyraPaths.UserTrashDir(_config, _contentRoot, userId);
        var bodies = _state.Snapshot(userId).Select(n => n.Body ?? string.Empty).ToArray();
        var moved = 0;

        foreach (var path in Directory.EnumerateFiles(mediaDir))
        {
            var name = Path.GetFileName(path);
            if (bodies.Any(b => b.Contains(name, StringComparison.Ordinal))) continue;

            Directory.CreateDirectory(trashDir);
            var dest = Path.Combine(trashDir, name);
            if (File.Exists(dest)) // collision-safe: never clobber an earlier trash entry
                dest = Path.Combine(trashDir, $"{Path.GetFileNameWithoutExtension(name)}.{Guid.NewGuid():N}{Path.GetExtension(name)}");

            File.Move(path, dest);
            moved++;
        }

        return moved;
    }
}
