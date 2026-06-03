using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Services;

// ── TokenService ──────────────────────────────────────────────────────────────
// Generates and validates single-use, time-boxed tokens for:
//   • email verification  (24-hour lifetime)
//   • password reset      (1-hour lifetime)
//
// Token wire format: "<random32bytes_urlbase64>.<expiry_utcticks>"
// Validation: hash the incoming token, compare FixedTimeEquals to the stored hash,
// and check that expiry has not passed.

public sealed class TokenService
{
    private const int RandomBytes = 32;

    // ── Generate ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns (plainToken, hash, expiryUtcTicks).
    /// Store hash + expiry on the user; send plainToken in the email link.
    /// </summary>
    public static (string token, string hash, long expiryTicks) Generate(TimeSpan lifetime)
    {
        var random  = RandomNumberGenerator.GetBytes(RandomBytes);
        var expiry  = DateTime.UtcNow.Add(lifetime).Ticks;
        var token   = $"{Base64UrlEncode(random)}.{expiry}";
        var hash    = Hash(token);
        return (token, hash, expiry);
    }

    // ── Validate ─────────────────────────────────────────────────────────────

    /// <param name="token">The raw token from the email link.</param>
    /// <param name="storedHash">SHA-256 hex stored on the user record.</param>
    /// <param name="storedExpiry">Expiry in UTC ticks stored on the user record.</param>
    public static bool IsValid(string token, string? storedHash, long storedExpiry)
    {
        if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(storedHash))
            return false;

        if (DateTime.UtcNow.Ticks > storedExpiry)
            return false;

        var incoming = Hash(token);

        // Constant-time compare to prevent timing attacks
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(incoming),
            Encoding.UTF8.GetBytes(storedHash));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    public static string Hash(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes)
               .TrimEnd('=')
               .Replace('+', '-')
               .Replace('/', '_');

    // ── Lifetimes ────────────────────────────────────────────────────────────
    public static readonly TimeSpan EmailVerificationLifetime = TimeSpan.FromHours(24);
    public static readonly TimeSpan PasswordResetLifetime     = TimeSpan.FromHours(1);
}
