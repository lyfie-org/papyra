using System.Collections.Concurrent;

namespace Papyra.Api.Storage;

// In-memory holding pen for the WebAuthn option blobs issued by a challenge and
// consumed by the matching verify. Kept in its own singleton because the service
// that uses it is request-scoped (Fido2NetLib's IFido2 is scoped), so the pending
// state has to outlive a single request.
//
// Challenges are single-use: Take() removes them, so a replayed verify finds nothing.
public sealed class WebAuthnChallengeStore
{
    private readonly ConcurrentDictionary<string, string> _create = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _assert = new(StringComparer.Ordinal);

    public void PutCreate(string userId, string optionsJson) => _create[userId] = optionsJson;
    public void PutAssert(string userId, string optionsJson) => _assert[userId] = optionsJson;

    public string? TakeCreate(string userId) => _create.TryRemove(userId, out var json) ? json : null;
    public string? TakeAssert(string userId) => _assert.TryRemove(userId, out var json) ? json : null;
}
