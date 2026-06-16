namespace Papyra.Api.Storage;

// Nightly housekeeping: any file in the media dir that no live note references
// (via ![[filename]] or a bare mention in its body) is moved to .trash — never
// hard-deleted, so a mistaken prune is always recoverable. Drives off VaultState,
// the in-memory mirror of the vault. Registered as a hosted service.
public sealed class OrphanPruneService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    private readonly VaultState _state;
    private readonly string _mediaDir;
    private readonly string _trashDir;
    private readonly ILogger<OrphanPruneService> _logger;

    public OrphanPruneService(
        VaultState state,
        IConfiguration config,
        IHostEnvironment env,
        ILogger<OrphanPruneService> logger)
    {
        _state = state;
        _mediaDir = PapyraPaths.MediaDir(config, env.ContentRootPath);
        _trashDir = PapyraPaths.TrashDir(config, env.ContentRootPath);
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

    // Move every unreferenced media file to .trash. Returns the count moved.
    internal int PruneOnce()
    {
        if (!Directory.Exists(_mediaDir)) return 0;

        var bodies = _state.Snapshot().Select(n => n.Body ?? string.Empty).ToArray();
        var moved = 0;

        foreach (var path in Directory.EnumerateFiles(_mediaDir))
        {
            var name = Path.GetFileName(path);
            if (bodies.Any(b => b.Contains(name, StringComparison.Ordinal))) continue;

            Directory.CreateDirectory(_trashDir);
            var dest = Path.Combine(_trashDir, name);
            if (File.Exists(dest)) // collision-safe: never clobber an earlier trash entry
                dest = Path.Combine(_trashDir, $"{Path.GetFileNameWithoutExtension(name)}.{Guid.NewGuid():N}{Path.GetExtension(name)}");

            File.Move(path, dest);
            moved++;
        }

        if (moved > 0) _logger.LogInformation("Orphan prune: moved {Count} unreferenced media file(s) to .trash", moved);
        return moved;
    }
}
