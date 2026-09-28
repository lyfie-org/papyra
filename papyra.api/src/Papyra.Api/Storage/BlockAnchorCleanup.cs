using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

/// <summary>
/// Removes the <c>^k2x9abcd</c> block anchors nothing points at.
///
/// The editor used to stamp an anchor onto every paragraph and heading at every
/// save, so any block could later be embedded elsewhere (<c>![[Note#^id]]</c>).
/// Almost none ever were, and the anchors sat at the end of nearly every line of
/// every file — noise in a vault that is meant to read cleanly in any editor,
/// and in every export. The editor no longer stamps them; this sweeps up the
/// ones already written, keeping any anchor that some note references or a
/// shared-block grant depends on.
///
/// A cleaned file keeps its last-modified time: nothing about the note changed,
/// so its "edited" date and sort position must not either.
/// </summary>
public sealed class BlockAnchorCleanup
{
    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly MarkdownStorageService _storage;
    private readonly WriteRing _writeRing;

    public BlockAnchorCleanup(IServiceScopeFactory scopes, VaultState state, MarkdownStorageService storage, WriteRing writeRing)
    {
        _scopes = scopes;
        _state = state;
        _storage = storage;
        _writeRing = writeRing;
    }

    /// <summary>Anchor ids still in use: referenced by any note, or held by a block grant.</summary>
    public async Task<HashSet<string>> InUseAsync(CancellationToken ct)
    {
        var keep = new HashSet<string>(StringComparer.Ordinal);
        foreach (var uid in _state.Users)
            foreach (var note in _state.Snapshot(uid))
                foreach (var id in BlockResolver.References(note.Body)) keep.Add(id);

        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var id in await db.BlockGrants.Where(g => g.BlockId != "").Select(g => g.BlockId).ToListAsync(ct))
            keep.Add(id);
        return keep;
    }

    /// <summary>Strip unused anchors from every note on disk. Returns how many notes changed.</summary>
    public async Task<int> RunAsync(CancellationToken ct)
    {
        var keep = await InUseAsync(ct);
        var changed = 0;
        foreach (var uid in _state.Users)
        {
            foreach (var note in _state.Snapshot(uid))
            {
                ct.ThrowIfCancellationRequested();
                var cleaned = BlockResolver.StripAnchors(note.Body, keep);
                if (ReferenceEquals(cleaned, note.Body) || cleaned == note.Body) continue;
                var path = _state.PathFor(uid, note.Id);
                if (path is null || !File.Exists(path)) continue;

                var modified = File.GetLastWriteTimeUtc(path);
                note.Body = cleaned;
                _writeRing.Mark(path);
                await _storage.WriteAsync(path, note, ct);
                _writeRing.Mark(path);
                File.SetLastWriteTimeUtc(path, modified);
                note.Updated = modified;
                _state.Upsert(uid, path, note);
                changed++;
            }
        }
        return changed;
    }
}

/// <summary>Runs <see cref="BlockAnchorCleanup"/> shortly after boot, then daily.</summary>
public sealed class BlockAnchorCleanupJob : PeriodicJob
{
    private readonly BlockAnchorCleanup _cleanup;

    public BlockAnchorCleanupJob(BlockAnchorCleanup cleanup, JobRegistry registry) : base(registry) => _cleanup = cleanup;

    protected override string JobId => "anchor-cleanup";
    protected override string JobName => "Tidy block markers";
    protected override string JobDescription =>
        "Removes the hidden ^markers older versions of Papyra added to the end of lines, except where another "
        + "note links to that exact block. Your text and each note's edited date stay as they are.";
    protected override TimeSpan Interval => TimeSpan.FromHours(24);
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(3);

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var n = await _cleanup.RunAsync(ct);
        return n == 0 ? null : $"{n} note{(n == 1 ? "" : "s")} tidied";
    }
}
