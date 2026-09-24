using System.Collections.Concurrent;
using Papyra.Api.Security;

namespace Papyra.Api.Storage;

// In-memory holding pen for the WebAuthn option blobs issued by a challenge and
// consumed by the matching verify. Kept in its own singleton because the service
// that uses it is request-scoped, so the pending state has to outlive a request.
//
// Challenges are single-use (Take removes them, so a replayed verify finds
// nothing), expire after a few minutes (an abandoned prompt cannot be answered
// later), and remember the relying party they were issued for, so the answer is
// verified against the same host and origin the question was asked on.
public sealed class WebAuthnChallengeStore
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    public sealed record Pending(string OptionsJson, RelyingParty Party, DateTime ExpiresUtc);

    private readonly ConcurrentDictionary<string, Pending> _create = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Pending> _assert = new(StringComparer.Ordinal);

    public void PutCreate(string userId, string optionsJson, RelyingParty party) =>
        _create[userId] = new Pending(optionsJson, party, DateTime.UtcNow.Add(Lifetime));

    public void PutAssert(string userId, string optionsJson, RelyingParty party) =>
        _assert[userId] = new Pending(optionsJson, party, DateTime.UtcNow.Add(Lifetime));

    public Pending? TakeCreate(string userId) => Take(_create, userId);
    public Pending? TakeAssert(string userId) => Take(_assert, userId);

    private static Pending? Take(ConcurrentDictionary<string, Pending> map, string userId) =>
        map.TryRemove(userId, out var p) && p.ExpiresUtc > DateTime.UtcNow ? p : null;
}
