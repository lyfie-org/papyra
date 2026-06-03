using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Services;

// ── EncryptionService ────────────────────────────────────────────────────────
// AES-256-GCM authenticated encryption for secrets stored on disk (TOTP secrets,
// SMTP passwords, etc.). Key must be exactly 32 bytes, base64-encoded in the
// PAPYRA_DATA_KEY environment variable or configuration key.
//
// Envelope format: "enc:<nonce_b64>:<ciphertext_b64>:<tag_b64>"
// Fail-closed: Encrypt() throws if the key is absent or invalid.

public sealed class EncryptionService
{
    private const int NonceSize  = 12; // 96-bit nonce — GCM standard
    private const int TagSize    = 16; // 128-bit authentication tag
    internal const string Prefix = "enc:";

    private readonly byte[]? _key;

    public EncryptionService(IConfiguration configuration)
    {
        // Accept the key from config or env var (config wins if both are set)
        var raw = configuration["PAPYRA_DATA_KEY"]
            ?? Environment.GetEnvironmentVariable("PAPYRA_DATA_KEY");

        if (string.IsNullOrWhiteSpace(raw)) return;

        try
        {
            var decoded = Convert.FromBase64String(raw);
            if (decoded.Length == 32) _key = decoded;
        }
        catch
        {
            // Invalid base64 — service starts without a key; Encrypt() will throw on first use
        }
    }

    public bool HasKey => _key is { Length: 32 };

    public string Encrypt(string plaintext)
    {
        if (_key is not { Length: 32 })
            throw new InvalidOperationException(
                "PAPYRA_DATA_KEY is not configured or is not a valid 32-byte base64 string. " +
                "Set this environment variable to encrypt secrets at rest.");

        var nonce      = RandomNumberGenerator.GetBytes(NonceSize);
        var data       = Encoding.UTF8.GetBytes(plaintext);
        var ciphertext = new byte[data.Length];
        var tag        = new byte[TagSize];

        using var aes = new AesGcm(_key.AsSpan(), TagSize);
        aes.Encrypt(nonce, data, ciphertext, tag);

        return $"{Prefix}{Convert.ToBase64String(nonce)}:" +
               $"{Convert.ToBase64String(ciphertext)}:{Convert.ToBase64String(tag)}";
    }

    public string Decrypt(string envelope)
    {
        if (_key is not { Length: 32 })
            throw new InvalidOperationException(
                "PAPYRA_DATA_KEY is not configured. Cannot decrypt stored secrets.");

        if (!envelope.StartsWith(Prefix, StringComparison.Ordinal))
            throw new FormatException("Value is not a valid encryption envelope.");

        var parts = envelope[Prefix.Length..].Split(':');
        if (parts.Length != 3)
            throw new FormatException("Malformed encryption envelope — expected 3 colon-separated parts.");

        var nonce      = Convert.FromBase64String(parts[0]);
        var ciphertext = Convert.FromBase64String(parts[1]);
        var tag        = Convert.FromBase64String(parts[2]);
        var plaintext  = new byte[ciphertext.Length];

        using var aes = new AesGcm(_key.AsSpan(), TagSize);
        aes.Decrypt(nonce, ciphertext, tag, plaintext);

        return Encoding.UTF8.GetString(plaintext);
    }

    // True when the stored value is a legacy plaintext (not an encrypted envelope).
    // Used to detect and transparently migrate old TOTP secrets.
    public static bool IsPlaintext(string? stored) =>
        stored is not null && !stored.StartsWith(Prefix, StringComparison.Ordinal);
}
