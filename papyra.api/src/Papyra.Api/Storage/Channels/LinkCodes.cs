using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Storage.Channels;

/// <summary>One-time codes that prove a chat account is the person's (see <see cref="Models.ChannelLinkCode"/>).</summary>
public static class LinkCodes
{
    private const string Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

    /// <summary>A random code of <paramref name="length"/> letters and digits from a 32-symbol alphabet (5 bits each).</summary>
    public static string New(int length)
    {
        var chars = new char[length];
        for (var i = 0; i < chars.Length; i++) chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }

    /// <summary>What is stored: the hex SHA-256 of the code. A code is never kept.</summary>
    public static string Hash(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code.Trim()))).ToLowerInvariant();

    /// <summary>A code as a person types it: any case, with or without a dash or spaces.</summary>
    public static string Normalize(string? typed) =>
        new((typed ?? string.Empty).Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
}
