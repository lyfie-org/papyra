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

    /// <summary>
    /// EVERY note of the tenant, journal entries included. Use it wherever a note
    /// can be destroyed, aged out, rewritten or has to be found — orphan pruning,
    /// trash purge, rename propagation, sealing, search, backlinks, backup. A
    /// journal-only photo must never look unreferenced.
    /// </summary>
    public IReadOnlyCollection<Note> SnapshotAll(string userId) => Bucket(userId).Values.ToArray();

    /// <summary>
    /// What belongs on the notes desk: everything but journal entries. Use it for
    /// anything the person sees as "their notes" — the list, the heatmap,
    /// collections, tags, bulk operations.
    /// </summary>
    public IReadOnlyCollection<Note> SnapshotDesk(string userId) =>
        Bucket(userId).Values.Where(n => !JournalPaths.IsJournal(n)).ToArray();

    /// <summary>Only the tenant's journal entries.</summary>
    public IReadOnlyCollection<Note> SnapshotJournal(string userId) =>
        Bucket(userId).Values.Where(JournalPaths.IsJournal).ToArray();

    /// <summary>Forget everything held for one tenant (the account was deleted).</summary>
    public void RemoveUser(string userId) => _byUser.TryRemove(userId, out _);

    public int Count(string userId) => Bucket(userId).Count;

    // Tenants currently tracked — used by housekeeping that sweeps every vault.
    public IReadOnlyCollection<string> Users => _byUser.Keys.ToArray();
}
