using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Security;

/// <summary>
/// Time-based one-time passwords (RFC 6238) — the six-digit codes an
/// authenticator app (Google Authenticator, 1Password, Aegis…) shows. Pure so it
/// can be tested against the RFC's own vectors without a database.
///
/// Papyra uses them where it would otherwise email a code: a fresh instance has
/// no outgoing mail, so the first admin's proof of "it's really me" has to work
/// without it. SHA-1, 30-second steps, six digits — the defaults every app
/// assumes when an otpauth:// URI leaves them out.
/// </summary>
public static class Totp
{
    public const int Digits = 6;
    public const int StepSeconds = 30;
    /// <summary>Steps either side of now that still count, for clock drift.</summary>
    public const int Window = 1;

    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>A new random 160-bit secret, Base32 (what apps expect to be typed).</summary>
    public static string NewSecret() => Base32Encode(RandomNumberGenerator.GetBytes(20));

    /// <summary>The time step a moment falls in.</summary>
    public static long StepAt(DateTimeOffset at) => at.ToUnixTimeSeconds() / StepSeconds;

    /// <summary>The code for one time step.</summary>
    public static string CodeAt(byte[] key, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        for (var i = 7; i >= 0; i--) { counter[i] = (byte)(step & 0xff); step >>= 8; }
        var hash = HMACSHA1.HashData(key, counter);
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6");
    }

    /// <summary>
    /// The time step <paramref name="code"/> belongs to, or null when it matches
    /// none in the window. A step at or before <paramref name="lastUsedStep"/> is
    /// refused, so a code seen over someone's shoulder can't be replayed.
    /// </summary>
    public static long? Match(string secret, string? code, DateTimeOffset now, long? lastUsedStep = null)
    {
        var typed = (code ?? string.Empty).Replace(" ", string.Empty).Trim();
        if (typed.Length != Digits || !typed.All(char.IsAsciiDigit)) return null;
        byte[] key;
        try { key = Base32Decode(secret); }
        catch (FormatException) { return null; }
        if (key.Length == 0) return null;

        var current = StepAt(now);
        for (var step = current - Window; step <= current + Window; step++)
        {
            if (lastUsedStep is { } last && step <= last) continue;
            if (CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(CodeAt(key, step)), Encoding.ASCII.GetBytes(typed)))
                return step;
        }
        return null;
    }

    /// <summary>
    /// The otpauth:// link an authenticator app scans (as a QR code) or opens (a
    /// tap on a phone), labelled "Papyra (you@host)".
    /// </summary>
    public static string ProvisioningUri(string secret, string account, string issuer = "Papyra") =>
        $"otpauth://totp/{Uri.EscapeDataString(issuer)}:{Uri.EscapeDataString(account)}"
        + $"?secret={secret}&issuer={Uri.EscapeDataString(issuer)}&algorithm=SHA1&digits={Digits}&period={StepSeconds}";

    public static string Base32Encode(ReadOnlySpan<byte> data)
    {
        var sb = new StringBuilder((data.Length + 4) / 5 * 8);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Base32Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    /// <summary>Decodes Base32, forgiving case, spaces, dashes and padding (as people type it).</summary>
    public static byte[] Base32Decode(string text)
    {
        var clean = text.Replace(" ", string.Empty).Replace("-", string.Empty).TrimEnd('=').ToUpperInvariant();
        var output = new List<byte>(clean.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var value = Base32Alphabet.IndexOf(c);
            if (value < 0) throw new FormatException("Not Base32.");
            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)((buffer >> (bits - 8)) & 0xff));
                bits -= 8;
            }
        }
        return [.. output];
    }
}
