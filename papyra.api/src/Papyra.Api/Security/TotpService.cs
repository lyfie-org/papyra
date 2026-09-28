using Microsoft.AspNetCore.DataProtection;
using Papyra.Api.Models;

namespace Papyra.Api.Security;

/// <summary>
/// A person's authenticator app: the secret it shares with Papyra, kept
/// encrypted on their row with the instance's data-protection keys, and the
/// check that spends a code.
///
/// It is the first way to prove "it's me" before something that can't be
/// undone (moving the account to another email, deleting it); a code emailed
/// to the account is the second, and only works where this Papyra can send mail.
/// </summary>
public sealed class TotpService(IDataProtectionProvider dataProtection)
{
    private readonly IDataProtector _protector = dataProtection.CreateProtector("Papyra.Totp.v1");

    public static bool IsEnabled(User user) => !string.IsNullOrEmpty(user.TotpSecret);

    /// <summary>Turn the authenticator on (or replace it) with a secret the person has just proven.</summary>
    public void Enable(User user, string secret, long provenStep)
    {
        user.TotpSecret = _protector.Protect(secret);
        user.TotpLastStep = provenStep;
        user.TotpEnabledUtc = DateTime.UtcNow;
    }

    public static void Disable(User user)
    {
        user.TotpSecret = null;
        user.TotpLastStep = null;
        user.TotpEnabledUtc = null;
    }

    /// <summary>
    /// Whether <paramref name="code"/> is the account's current authenticator
    /// code. A match is spent — the caller saves the row — so the same code can't
    /// be used twice.
    /// </summary>
    public bool Verify(User user, string? code)
    {
        if (!IsEnabled(user) || string.IsNullOrWhiteSpace(code)) return false;
        string secret;
        try { secret = _protector.Unprotect(user.TotpSecret!); }
        catch (System.Security.Cryptography.CryptographicException) { return false; } // keys lost: set it up again
        if (Totp.Match(secret, code, DateTimeOffset.UtcNow, user.TotpLastStep) is not { } step) return false;
        user.TotpLastStep = step;
        return true;
    }
}
