using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Papyra.Api.Storage;

/// <summary>
/// One-time, two-minute tickets that let a confirmed person download their full
/// export. Earned by password + vault unlock (POST /api/export/authorize) and
/// spent by the download itself, so the zip is a plain browser download and not
/// something a stolen session can fetch on its own. In memory: a restart simply
/// asks the person to confirm again.
/// </summary>
public sealed class ExportTicketStore
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<string, (string UserId, DateTime ExpiresUtc)> _tickets = new(StringComparer.Ordinal);

    public string Issue(string userId)
    {
        foreach (var (t, e) in _tickets)
            if (e.ExpiresUtc <= DateTime.UtcNow) _tickets.TryRemove(t, out _);
        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        _tickets[ticket] = (userId, DateTime.UtcNow.Add(Lifetime));
        return ticket;
    }

    /// <summary>True (and the ticket is spent) for a live ticket issued to this user.</summary>
    public bool Redeem(string? ticket, string userId)
    {
        if (string.IsNullOrEmpty(ticket) || !_tickets.TryRemove(ticket, out var entry)) return false;
        return entry.ExpiresUtc > DateTime.UtcNow && string.Equals(entry.UserId, userId, StringComparison.Ordinal);
    }
}
