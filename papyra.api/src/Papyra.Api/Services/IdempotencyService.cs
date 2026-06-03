using System.Collections.Concurrent;

namespace Papyra.Api.Services;

// ── IdempotencyService ────────────────────────────────────────────────────────
// In-memory store for idempotency keys on note write endpoints.
// When an offline client replays a queued mutation it sends the same
// X-Idempotency-Key header; if the server already applied that key within the
// TTL window it returns 200 immediately without re-writing the file.

public sealed class IdempotencyService
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new(StringComparer.Ordinal);
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);

    public bool HasSeen(string key)
    {
        Cleanup();
        return _seen.TryGetValue(key, out var expiry) && expiry > DateTimeOffset.UtcNow;
    }

    public void Record(string key) =>
        _seen[key] = DateTimeOffset.UtcNow.Add(Ttl);

    private void Cleanup()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var kv in _seen)
            if (kv.Value <= now) _seen.TryRemove(kv.Key, out _);
    }
}
