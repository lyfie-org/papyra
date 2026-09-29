using System.Text.Json;
using Papyra.Api.Storage;

namespace Papyra.Api.Collab;

/// <summary>
/// Persisted Yjs state of each note's room, so a room reopens with its CRDT
/// history (peers reconnecting after a restart merge cleanly) instead of being
/// re-seeded from markdown. A disposable cache under the owner's <c>.papyra/</c>
/// — never in the notes dir — and only trusted while the file on disk still
/// has the hash it was saved against; otherwise the file wins.
/// </summary>
public sealed class CollabStateStore(IConfiguration config, IHostEnvironment env, ILogger<CollabStateStore> logger)
{
    private string Dir(string ownerUid) =>
        Path.Combine(PapyraPaths.UserDotPapyra(config, env.ContentRootPath, ownerUid), "collab");

    private (string State, string Hash) Files(string ownerUid, string noteId)
    {
        var dir = Dir(ownerUid);
        var state = PathGuard.ResolveAndVerify(dir, $"{noteId}.ystate", logger);
        return (state, state + ".hash");
    }

    public async Task<(byte[] State, string Hash)?> ReadAsync(string ownerUid, string noteId, CancellationToken ct)
    {
        var (statePath, hashPath) = Files(ownerUid, noteId);
        if (!File.Exists(statePath) || !File.Exists(hashPath)) return null;
        try
        {
            return (await File.ReadAllBytesAsync(statePath, ct), (await File.ReadAllTextAsync(hashPath, ct)).Trim());
        }
        catch (IOException ex)
        {
            logger.LogWarning(ex, "Unreadable collab state for {Note}; the room will reseed from the file.", noteId);
            return null;
        }
    }

    /// <summary>Atomic replace (tmp → flush → move), hash written last so a torn pair is never trusted.</summary>
    public async Task WriteAsync(string ownerUid, string noteId, byte[] state, string hash, CancellationToken ct)
    {
        Directory.CreateDirectory(Dir(ownerUid));
        var (statePath, hashPath) = Files(ownerUid, noteId);
        if (File.Exists(hashPath)) File.Delete(hashPath);
        await WriteAtomicAsync(statePath, state, ct);
        await WriteAtomicAsync(hashPath, System.Text.Encoding.UTF8.GetBytes(hash), ct);
    }

    public void Delete(string ownerUid, string noteId)
    {
        var (statePath, hashPath) = Files(ownerUid, noteId);
        if (File.Exists(hashPath)) File.Delete(hashPath);
        if (File.Exists(statePath)) File.Delete(statePath);
        var pending = PendingPath(ownerUid, noteId);
        if (File.Exists(pending)) File.Delete(pending);
    }

    // ── Who wrote what (history attribution) ────────────────────────────────
    // The room saves often but a version is only archived every few minutes, so
    // the people behind the file's current text are remembered here until the
    // snapshot that will hold that text exists — then they move onto it.

    private string PendingPath(string ownerUid, string noteId) =>
        PathGuard.ResolveAndVerify(Dir(ownerUid), $"{noteId}.by", logger);

    public async Task<int[]> ReadPendingContributorsAsync(string ownerUid, string noteId, CancellationToken ct)
    {
        var path = PendingPath(ownerUid, noteId);
        if (!File.Exists(path)) return [];
        try
        {
            return JsonSerializer.Deserialize<int[]>(await File.ReadAllTextAsync(path, ct)) ?? [];
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return []; // attribution is best-effort; a torn file just means "unknown"
        }
    }

    public async Task WritePendingContributorsAsync(
        string ownerUid, string noteId, IReadOnlyCollection<int> uids, CancellationToken ct)
    {
        var path = PendingPath(ownerUid, noteId);
        if (uids.Count == 0)
        {
            if (File.Exists(path)) File.Delete(path);
            return;
        }
        Directory.CreateDirectory(Dir(ownerUid));
        await WriteAtomicAsync(path, JsonSerializer.SerializeToUtf8Bytes(uids.Distinct().ToArray()), ct);
    }

    /// <summary>
    /// A snapshot now holds the file's current text: hand it the people who
    /// wrote that text. A null id (capture throttled) leaves them waiting for
    /// the next snapshot.
    /// </summary>
    public async Task AttributeSnapshotAsync(
        SnapshotService snapshots, string ownerUid, string noteId, string noteSnapDir, string? snapshotId,
        CancellationToken ct)
    {
        if (snapshotId is null) return;
        var pending = await ReadPendingContributorsAsync(ownerUid, noteId, ct);
        if (pending.Length == 0) return;
        snapshots.SetContributors(noteSnapDir, snapshotId, pending);
        await WritePendingContributorsAsync(ownerUid, noteId, [], ct);
    }

    private static async Task WriteAtomicAsync(string path, byte[] bytes, CancellationToken ct)
    {
        var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
        await using (var stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, true))
        {
            await stream.WriteAsync(bytes, ct);
            await stream.FlushAsync(ct);
            stream.Flush(flushToDisk: true);
        }
        File.Move(tmp, path, overwrite: true);
    }
}
