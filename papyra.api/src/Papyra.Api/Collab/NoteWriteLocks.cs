using System.Collections.Concurrent;

namespace Papyra.Api.Collab;

/// <summary>
/// Serializes writes to one note file. With a live room saving the body in
/// the background, a metadata write (pin, tags, trash) that read the note a
/// moment earlier would otherwise write that stale body back over the room's
/// fresh save — and the room would later read it as someone reverting text.
/// Writers take the lock, re-read the body from disk, then write.
/// </summary>
public sealed class NoteWriteLocks
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    public async Task<IDisposable> AcquireAsync(string ownerUid, string noteId, CancellationToken ct)
    {
        var gate = _locks.GetOrAdd($"{ownerUid}:{noteId}", _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Release(gate);
    }

    private sealed class Release(SemaphoreSlim gate) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0) gate.Release();
        }
    }
}
