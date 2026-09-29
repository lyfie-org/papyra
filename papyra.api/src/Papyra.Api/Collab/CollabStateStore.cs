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
