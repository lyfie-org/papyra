using Microsoft.Extensions.Caching.Memory;

namespace Papyra.Api.Security;

// Per-account brute-force brake for /api/auth/login.
//
// The IP-keyed rate limiter on the auth group is the blunt instrument; it is also
// the one a reverse proxy defeats, because without forwarded-header trust every
// request arrives from the proxy's address and shares a bucket. This counter is
// keyed on the *username* instead, so it holds regardless of what the network
// looks like, and it is what actually caps guesses against one account.
//
// Trade-off, stated plainly: an attacker who knows a username can keep that
// account locked out by failing on purpose. That is the standard cost of a
// lockout, and for a self-hosted instance it beats leaving guessing uncapped —
// the window is short and the counter clears the moment a real login succeeds.
public sealed class LoginThrottle
{
    /// <summary>Failures tolerated within <see cref="Window"/> before refusing.</summary>
    public const int MaxFailures = 10;

    /// <summary>How long failures are remembered, and how long a lockout lasts.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(15);

    private readonly IMemoryCache _cache;

    public LoginThrottle(IMemoryCache cache) => _cache = cache;

    private static string Key(string username) => $"login-fail:{username.Trim().ToLowerInvariant()}";

    /// <summary>True when this account has spent its budget and should be refused outright.</summary>
    public bool IsLockedOut(string? username) =>
        !string.IsNullOrWhiteSpace(username)
        && _cache.TryGetValue<int>(Key(username), out var failures)
        && failures >= MaxFailures;

    /// <summary>
    /// Record a failed attempt. The sliding window restarts on each failure, so a
    /// steady trickle of guesses stays locked rather than topping up its budget.
    /// </summary>
    public void RecordFailure(string? username)
    {
        if (string.IsNullOrWhiteSpace(username)) return;
        var key = Key(username);
        var failures = _cache.TryGetValue<int>(key, out var current) ? current + 1 : 1;
        _cache.Set(key, failures, Window);
    }

    /// <summary>A correct password clears the account's history immediately.</summary>
    public void Reset(string? username)
    {
        if (string.IsNullOrWhiteSpace(username)) return;
        _cache.Remove(Key(username));
    }
}
