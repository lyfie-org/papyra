using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Security;

namespace Papyra.Api.Storage;

/// <summary>
/// Seals the secrets an admin or a user types into Papyra — the SMTP password, an SSO client
/// secret, a git token — before they are written to the database, and opens them again on the way
/// out. They are sealed with ASP.NET Data Protection, so they are only readable with the key ring
/// that lives beside the data (<c>.papyra/keys</c>); a copy of <c>papyra.db</c> on its own no
/// longer shows them.
///
/// A sealed value reads <c>enc:v1:…</c>. Anything without that prefix is an older, plain value:
/// it is still accepted as is, and <see cref="SecretSettings.SealLegacyAsync"/> seals it once at
/// start-up, so an upgrade needs nothing from the admin.
///
/// If the key ring is gone, a sealed value can't be opened. It then reads as "not set" (the
/// settings screens already show that as a blank secret) rather than failing the request or the
/// boot; the person types the secret again. Notes are never involved.
/// </summary>
public sealed class SecretBox
{
    public const string Prefix = "enc:v1:";

    private readonly IDataProtector _protector;
    private readonly ILogger<SecretBox> _logger;

    public SecretBox(IDataProtectionProvider dataProtection, ILogger<SecretBox> logger)
    {
        _protector = dataProtection.CreateProtector("Papyra.InstanceSecrets.v1");
        _logger = logger;
    }

    public static bool IsSealed(string? stored) =>
        stored is not null && stored.StartsWith(Prefix, StringComparison.Ordinal);

    /// <summary>Seal a secret for storage. Blank and already-sealed values pass through unchanged.</summary>
    public string? Seal(string? plain) =>
        string.IsNullOrEmpty(plain) || IsSealed(plain) ? plain : Prefix + _protector.Protect(plain);

    /// <summary>
    /// The secret behind a stored value. A plain (older) value is returned as is; a sealed one is
    /// opened, or comes back null when this key ring can't open it. <paramref name="what"/> only
    /// names the setting in the log — never the value.
    /// </summary>
    public string? Open(string? stored, string what = "a saved secret")
    {
        if (string.IsNullOrEmpty(stored) || !IsSealed(stored)) return stored;
        try
        {
            return _protector.Unprotect(stored[Prefix.Length..]);
        }
        catch (CryptographicException)
        {
            _logger.LogWarning(
                "{What} could not be opened with this instance's keys, so it is treated as not set. "
                + "Enter it again in Settings.", what);
            return null;
        }
    }
}

/// <summary>Which settings rows hold a secret, and the one-time upgrade that seals the old ones.</summary>
public static class SecretSettings
{
    /// <summary>Instance-wide secrets, read and written through <see cref="InstanceConfigStore"/>.</summary>
    public static readonly IReadOnlySet<string> StoreKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        SmtpKeys.Password,
        OidcKeys.ClientSecret,
        InstanceBackupKeys.GitToken,
    };

    // Rows the upgrade looks at: the store's, plus every account's own git token (git.u{id}.token)
    // and the pre-per-account one. The SSO client secrets live inside one JSON row, handled apart.
    private static readonly string[] FixedKeys = [.. StoreKeys, "git.token"];

    /// <summary>
    /// Seal every secret still stored in plain. Safe to run on every start: sealed and blank values
    /// are left alone. Returns how many were sealed. A failure is logged and swallowed — the plain
    /// values keep working, and the next start tries again.
    /// </summary>
    public static async Task<int> SealLegacyAsync(
        AppDbContext db, SecretBox box, ILogger log, CancellationToken ct = default)
    {
        try
        {
            var rows = await db.Settings
                .Where(s => FixedKeys.Contains(s.Key)
                    || (s.Key.StartsWith("git.u") && s.Key.EndsWith(".token")))
                .ToListAsync(ct);

            var sealedCount = 0;
            foreach (var row in rows)
            {
                if (string.IsNullOrEmpty(row.Value) || SecretBox.IsSealed(row.Value)) continue;
                row.Value = box.Seal(row.Value);
                sealedCount++;
            }

            var sso = await db.Settings.FindAsync([SsoProviders.ProvidersKey], ct);
            if (SsoProviders.SealStored(sso?.Value, box) is { } resealed)
            {
                sso!.Value = resealed;
                sealedCount++;
            }

            if (sealedCount > 0)
            {
                await db.SaveChangesAsync(ct);
                log.LogInformation("Sealed {Count} saved secret(s) that were stored in plain text", sealedCount);
            }
            return sealedCount;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Saved secrets could not be sealed this start; they stay as they were and it will be tried again");
            return 0;
        }
    }
}
