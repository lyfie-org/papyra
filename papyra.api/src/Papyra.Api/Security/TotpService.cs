using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Security;

/// <summary>
/// A person's authenticator apps: each shares a secret with Papyra, kept
/// encrypted with the instance's data-protection keys, and any of them can
/// answer a code. Several are allowed (a phone and a password manager, say), so
/// losing one isn't losing the account; the last one can't be removed.
///
/// It is the first way to prove "it's me" before something that can't be
/// undone; a code emailed to the account is the second, where mail works.
/// </summary>
public sealed class TotpService(IDataProtectionProvider dataProtection, AppDbContext db)
{
    private readonly IDataProtector _protector = dataProtection.CreateProtector("Papyra.Totp.v1");

    public Task<bool> HasAnyAsync(int userId, CancellationToken ct = default) =>
        db.UserAuthenticators.AnyAsync(a => a.UserId == userId, ct);

    public Task<List<UserAuthenticator>> ListAsync(int userId, CancellationToken ct = default) =>
        db.UserAuthenticators.Where(a => a.UserId == userId).OrderBy(a => a.CreatedUtc).ToListAsync(ct);

    /// <summary>Add an authenticator whose code has just been proven. The caller saves.</summary>
    public void Add(int userId, string name, string secret, long provenStep)
    {
        var now = DateTime.UtcNow;
        db.UserAuthenticators.Add(new UserAuthenticator
        {
            UserId = userId,
            Name = string.IsNullOrWhiteSpace(name) ? "Authenticator app" : name.Trim()[..Math.Min(name.Trim().Length, 60)],
            Secret = _protector.Protect(secret),
            LastStep = provenStep,
            CreatedUtc = now,
            LastUsedUtc = now,
        });
    }

    /// <summary>Forget every authenticator (an admin reset).</summary>
    public Task ClearAsync(int userId, CancellationToken ct = default) =>
        db.UserAuthenticators.Where(a => a.UserId == userId).ExecuteDeleteAsync(ct);

    /// <summary>
    /// Whether <paramref name="code"/> is the current code of any of the account's
    /// authenticators. A match is spent — the caller saves — so the same code
    /// can't be used twice.
    /// </summary>
    public async Task<bool> VerifyAsync(User user, string? code, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(code)) return false;
        var now = DateTimeOffset.UtcNow;
        foreach (var auth in await ListAsync(user.Id, ct))
        {
            string secret;
            try { secret = _protector.Unprotect(auth.Secret); }
            catch (System.Security.Cryptography.CryptographicException) { continue; } // keys lost: set it up again
            if (Totp.Match(secret, code, now, auth.LastStep) is not { } step) continue;
            auth.LastStep = step;
            auth.LastUsedUtc = DateTime.UtcNow;
            return true;
        }
        return false;
    }
}
