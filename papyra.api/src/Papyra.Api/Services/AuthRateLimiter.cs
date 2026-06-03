using System.Collections.Concurrent;

namespace Papyra.Api.Services;

// ── AuthRateLimiter ──────────────────────────────────────────────────────────
// Sliding-window failure tracker for auth endpoints (login, 2FA verify).
// 5 failures within 15 minutes per IP address triggers HTTP 429.
// Counter resets on a successful authentication for that IP.

public sealed class AuthRateLimiter
{
    private const int MaxFailures = 5;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(15);

    private readonly ConcurrentDictionary<string, List<DateTimeOffset>> _failures = new();

    public bool IsBlocked(string ip)
    {
        if (!_failures.TryGetValue(ip, out var times)) return false;
        var cutoff = DateTimeOffset.UtcNow - Window;
        lock (times)
        {
            times.RemoveAll(t => t < cutoff);
            return times.Count >= MaxFailures;
        }
    }

    public void RecordFailure(string ip)
    {
        var times = _failures.GetOrAdd(ip, _ => []);
        lock (times) { times.Add(DateTimeOffset.UtcNow); }
    }

    public void Reset(string ip) => _failures.TryRemove(ip, out _);

    // Extracts the real client IP, honoring X-Forwarded-For when ForwardedHeaders middleware is active.
    public static string GetIp(HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
