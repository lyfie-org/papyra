using System.Collections.Concurrent;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// In-memory mirror of the notes vault, partitioned per tenant: an outer map of
// userId → (absolute .md path → Note). The observer keeps it in sync with disk;
// it is disposable — the filesystem is the authority. Thread-safe so the watcher
// threads and request threads can share it. Registered as a singleton.
public sealed class VaultState
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, Note>> _byUser =
        new(StringComparer.Ordinal);

    private ConcurrentDictionary<string, Note> Bucket(string userId) =>
        _byUser.GetOrAdd(userId, _ => new ConcurrentDictionary<string, Note>(StringComparer.OrdinalIgnoreCase));

    public Note Upsert(string userId, string path, Note note) => Bucket(userId)[path] = note;

    public bool Remove(string userId, string path) => Bucket(userId).TryRemove(path, out _);

    public bool TryGet(string userId, string path, out Note? note) => Bucket(userId).TryGetValue(path, out note);

    // Resolve the absolute .md path of one user's note by its frontmatter id.
    public string? PathFor(string userId, string id) =>
        Bucket(userId).FirstOrDefault(kv => string.Equals(kv.Value.Id, id, StringComparison.Ordinal)).Key;

    public IReadOnlyCollection<Note> Snapshot(string userId) => Bucket(userId).Values.ToArray();

    public int Count(string userId) => Bucket(userId).Count;

    // Tenants currently tracked — used by housekeeping that sweeps every vault.
    public IReadOnlyCollection<string> Users => _byUser.Keys.ToArray();
}
