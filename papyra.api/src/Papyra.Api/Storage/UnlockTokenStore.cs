using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Papyra.Api.Storage;

// Short-lived, in-memory unlock tokens minted after a successful biometric
// (WebAuthn) assertion. A secure note's body is only released when a valid,
// unexpired token belonging to that user is presented — so the gate is enforced
// server-side, not just by a CSS blur.
//
// Deliberately ephemeral: tokens die with the process, so a restart re-locks
// everything. Nothing sensitive is persisted.
public sealed class UnlockTokenStore
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<string, (string UserId, DateTime ExpiresUtc)> _tokens = new(StringComparer.Ordinal);

    public string Issue(string userId)
    {
        Prune();
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        _tokens[token] = (userId, DateTime.UtcNow.Add(Lifetime));
        return token;
    }

    // True only for a live token owned by this user (one tenant's unlock can never
    // release another tenant's note).
    public bool IsValid(string? token, string userId)
    {
        if (string.IsNullOrEmpty(token)) return false;
        if (!_tokens.TryGetValue(token, out var entry)) return false;
        if (entry.ExpiresUtc <= DateTime.UtcNow)
        {
            _tokens.TryRemove(token, out _);
            return false;
        }
        return string.Equals(entry.UserId, userId, StringComparison.Ordinal);
    }

    public void Revoke(string token) => _tokens.TryRemove(token, out _);

    private void Prune()
    {
        var now = DateTime.UtcNow;
        foreach (var (token, entry) in _tokens)
            if (entry.ExpiresUtc <= now) _tokens.TryRemove(token, out _);
    }
}
