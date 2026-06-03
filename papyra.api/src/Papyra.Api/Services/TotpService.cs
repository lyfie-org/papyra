using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Services;

public sealed class TotpService
{
    private const int StepSeconds = 30;
    private const int Digits      = 6;
    private const int Window      = 1; // ±1 step tolerance

    // Recovery code alphabet — excludes O, 0, I, 1 to avoid transcription errors.
    // 32 chars divides 256 evenly → zero modulo bias.
    private const string RecoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public string[] GenerateRecoveryCodes(int count = 8)
    {
        var codes = new string[count];
        for (var i = 0; i < count; i++)
            codes[i] = GenerateRecoveryCode();
        return codes;
    }

    // Format: XXXX-XXXX-XXXX (12 random chars, ~60 bits of entropy)
    internal static string GenerateRecoveryCode()
    {
        var bytes = RandomNumberGenerator.GetBytes(12);
        var chars = new char[14];
        chars[4] = chars[9] = '-';
        var j = 0;
        for (var i = 0; i < 12; i++, j++)
        {
            if (j == 4 || j == 9) j++;
            chars[j] = RecoveryAlphabet[bytes[i] % RecoveryAlphabet.Length];
        }
        return new string(chars);
    }

    public string GenerateSecret()
    {
        var bytes = RandomNumberGenerator.GetBytes(20);
        return ToBase32(bytes);
    }

    public string GetOtpAuthUri(string secret, string username, string issuer = "Papyra")
    {
        var label          = Uri.EscapeDataString($"{issuer}:{username}");
        var encodedIssuer  = Uri.EscapeDataString(issuer);
        return $"otpauth://totp/{label}?secret={secret}&issuer={encodedIssuer}&algorithm=SHA1&digits=6&period=30";
    }

    public bool ValidateCode(string secret, string code)
    {
        if (code.Length != Digits || !code.All(char.IsDigit)) return false;
        byte[] key;
        try   { key = FromBase32(secret); }
        catch { return false; }

        var t = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / StepSeconds;
        for (var i = -Window; i <= Window; i++)
        {
            if (Compute(key, t + i) == code) return true;
        }
        return false;
    }

    private static string Compute(byte[] key, long counter)
    {
        var msg = BitConverter.GetBytes(counter);
        if (BitConverter.IsLittleEndian) Array.Reverse(msg);

        using var hmac = new HMACSHA1(key);
        var hash   = hmac.ComputeHash(msg);
        var offset = hash[^1] & 0x0f;
        var code   = (
            ((hash[offset]     & 0x7f) << 24) |
            ((hash[offset + 1] & 0xff) << 16) |
            ((hash[offset + 2] & 0xff) <<  8) |
             (hash[offset + 3] & 0xff)
        ) % 1_000_000;
        return code.ToString("D6");
    }

    private static string ToBase32(byte[] data)
    {
        const string Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var sb     = new StringBuilder();
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits  += 8;
            while (bits >= 5)
            {
                bits -= 5;
                sb.Append(Chars[(buffer >> bits) & 0x1f]);
            }
        }
        if (bits > 0) sb.Append(Chars[(buffer << (5 - bits)) & 0x1f]);
        return sb.ToString();
    }

    private static byte[] FromBase32(string input)
    {
        const string Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        input = input.ToUpperInvariant().TrimEnd('=');
        var result = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var c in input)
        {
            var idx = Chars.IndexOf(c);
            if (idx < 0) continue;
            buffer = (buffer << 5) | idx;
            bits  += 5;
            if (bits >= 8)
            {
                bits -= 8;
                result.Add((byte)(buffer >> bits));
            }
        }
        return [.. result];
    }
}
