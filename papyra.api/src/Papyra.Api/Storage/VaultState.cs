using System.Collections.Concurrent;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// In-memory mirror of the notes vault, keyed by absolute .md path. The observer
// keeps it in sync with disk; it is disposable — the filesystem is the authority.
// Thread-safe so the watcher thread and request threads can share it. Registered
// as a singleton.
public sealed class VaultState
{
    private readonly ConcurrentDictionary<string, Note> _notes =
        new(StringComparer.OrdinalIgnoreCase);

    public Note Upsert(string path, Note note) => _notes[path] = note;

    public bool Remove(string path) => _notes.TryRemove(path, out _);

    public bool TryGet(string path, out Note? note) => _notes.TryGetValue(path, out note);

    public IReadOnlyCollection<Note> Snapshot() => _notes.Values.ToArray();

    public int Count => _notes.Count;
}
