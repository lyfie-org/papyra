using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>
/// "Confirm it's you" — the one six-digit code Papyra asks for before a sensitive
/// step (two-step sign-in, exporting everything, a new API key). The code comes
/// from the authenticator app; an emailed code is the fallback where this Papyra
/// can send mail. Either kind is accepted wherever a code is asked for, so the
/// person only ever has one question to answer.
/// </summary>
public sealed class StepUpService(TotpService totp, EmailSender mail)
{
    private const string Kind = "step-up";

    private static string CodeHash(int userId, string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"step-up:{userId}:{code.Trim()}")));

    /// <summary>Whether an email code can be offered to this account at all.</summary>
    public bool CanEmail(User user) => mail.IsConfigured && !string.IsNullOrWhiteSpace(user.Email);

    /// <summary>
    /// Check (and spend) a code: the authenticator's, else an emailed one. The
    /// caller saves the row — an authenticator code moves its replay marker.
    /// </summary>
    public async Task<bool> VerifyAsync(AppDbContext db, User user, string? code, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code)) return false;
        if (totp.Verify(user, code)) return true;
        var hash = CodeHash(user.Id, code);
        var token = await db.AuthTokens.FirstOrDefaultAsync(t => t.UserId == user.Id && t.Kind == Kind && t.TokenHash == hash, ct);
        if (token is null || token.UsedUtc is not null || token.ExpiresUtc < DateTime.UtcNow) return false;
        token.UsedUtc = DateTime.UtcNow;
        return true;
    }

    /// <summary>Email a fresh code (replacing any earlier one). Returns the masked address, or null if it couldn't be sent.</summary>
    public async Task<string?> EmailCodeAsync(
        AppDbContext db, User user, IReadOnlyList<EmailDetail> details, CancellationToken ct)
    {
        if (!CanEmail(user)) return null;
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.UserId == user.Id && t.Kind == Kind));
        db.AuthTokens.Add(new AuthToken
        {
            TokenHash = CodeHash(user.Id, code),
            Kind = Kind,
            UserId = user.Id,
            Email = user.Email,
            Username = user.Username,
            ExpiresUtc = DateTime.UtcNow.AddMinutes(10),
        });
        await db.SaveChangesAsync(ct);
        var sent = await mail.SendAsync(user.Email, $"{code} is your Papyra code",
            $"Your code is {code}. It works once, for 10 minutes.\n\n"
            + "If you didn't ask for it, change your password.",
            [new EmailDetail("Code", code), .. details], ct);
        return sent.Sent ? Mask(user.Email) : null;
    }

    private static string Mask(string email)
    {
        var at = email.IndexOf('@');
        if (at <= 1) return email;
        return email[0] + new string('•', Math.Min(at - 1, 6)) + email[at..];
    }
}

/// <summary>
/// Sign-ins waiting on their second step: the password was right, the code is
/// still to come. Held in memory for five minutes and a handful of tries, so the
/// password never has to be sent twice.
/// </summary>
public sealed class PendingSignInStore
{
    public sealed record Pending(int UserId, bool Remember, DateTime ExpiresUtc)
    {
        public int Attempts { get; set; }
    }

    public const int MaxAttempts = 5;
    private readonly ConcurrentDictionary<string, Pending> _pending = new();

    public string Issue(int userId, bool remember)
    {
        foreach (var (key, p) in _pending) if (p.ExpiresUtc < DateTime.UtcNow) _pending.TryRemove(key, out _);
        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        _pending[ticket] = new Pending(userId, remember, DateTime.UtcNow.AddMinutes(5));
        return ticket;
    }

    public Pending? Find(string? ticket) =>
        ticket is not null && _pending.TryGetValue(ticket, out var p) && p.ExpiresUtc > DateTime.UtcNow ? p : null;

    /// <summary>Count a wrong code; the ticket dies after <see cref="MaxAttempts"/>.</summary>
    public void Fail(string ticket)
    {
        if (_pending.TryGetValue(ticket, out var p) && ++p.Attempts >= MaxAttempts) _pending.TryRemove(ticket, out _);
    }

    public void Spend(string ticket) => _pending.TryRemove(ticket, out _);
}
