using System.Collections.Concurrent;

namespace Papyra.Api.Storage;

// One conflict copy shadowing a parent note. Bodies are read from disk on demand
// (the .md is the authority); this carries only the metadata the grid + resolver
// need to list and address a conflict.
public sealed record ConflictInfo(
    string Id,                  // route-safe opaque key (base64url of RelativePath)
    string RelativePath,        // conflict file, relative to the user's notes dir
    string ParentRelativePath,  // the note it shadows, relative to the notes dir
    string ParentId,            // parent note's frontmatter id (for grid banners)
    string ConflictTitle,
    DateTime DetectedUtc);

// In-memory, per-tenant registry of unresolved conflict files — the conflict twin
// of VaultState. Disposable: rebuilt from disk by the cold-boot diff + watcher, so
// it never needs to survive a restart and can't drift from the filesystem.
public sealed class ConflictState
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, ConflictInfo>> _byUser =
        new(StringComparer.Ordinal);

    private ConcurrentDictionary<string, ConflictInfo> Bucket(string userId) =>
        _byUser.GetOrAdd(userId, _ => new ConcurrentDictionary<string, ConflictInfo>(StringComparer.Ordinal));

    public ConflictInfo Upsert(string userId, ConflictInfo info) => Bucket(userId)[info.Id] = info;

    public bool TryGet(string userId, string id, out ConflictInfo? info) => Bucket(userId).TryGetValue(id, out info);

    public bool Remove(string userId, string id, out ConflictInfo? info) => Bucket(userId).TryRemove(id, out info);

    public IReadOnlyCollection<ConflictInfo> Snapshot(string userId) => Bucket(userId).Values.ToArray();
}
