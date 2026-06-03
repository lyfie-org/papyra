using Microsoft.Extensions.Configuration;
using Papyra.Api.Services;

namespace Papyra.Tests.Auth;

public sealed class EncryptionServiceTests
{
    // ── Helpers ───────────────────────────────────────────────────────────────

    private static EncryptionService MakeService(byte[]? keyOverride = null)
    {
        var key    = keyOverride ?? new byte[32]; // 32 zero-bytes is a valid key
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PAPYRA_DATA_KEY"] = Convert.ToBase64String(key),
            })
            .Build();
        return new EncryptionService(config);
    }

    private static EncryptionService MakeServiceNoKey()
    {
        var config = new ConfigurationBuilder().Build(); // no key in config
        return new EncryptionService(config);
    }

    // ── Round-trip ────────────────────────────────────────────────────────────

    [Fact]
    public void Encrypt_Decrypt_RoundTrip()
    {
        var svc    = MakeService();
        const string plain = "JBSWY3DPEHPK3PXP";
        var enc    = svc.Encrypt(plain);
        Assert.Equal(plain, svc.Decrypt(enc));
    }

    [Fact]
    public void Encrypt_Decrypt_EmptyString_RoundTrip()
    {
        var svc = MakeService();
        var enc = svc.Encrypt(string.Empty);
        Assert.Equal(string.Empty, svc.Decrypt(enc));
    }

    [Fact]
    public void Encrypt_Prefix_IsEnc()
    {
        var svc = MakeService();
        Assert.StartsWith("enc:", svc.Encrypt("hello"));
    }

    [Fact]
    public void Encrypt_ProducesThreeColonParts()
    {
        var svc   = MakeService();
        var parts = svc.Encrypt("hello")[4..].Split(':');
        Assert.Equal(3, parts.Length);
    }

    [Fact]
    public void Encrypt_SamePlaintext_DifferentNonces()
    {
        var svc = MakeService();
        var a   = svc.Encrypt("same");
        var b   = svc.Encrypt("same");
        // Envelopes must differ because each encryption uses a fresh random nonce
        Assert.NotEqual(a, b);
    }

    // ── Authentication (tamper detection) ─────────────────────────────────────

    [Fact]
    public void Decrypt_TamperedTag_ThrowsCryptographicException()
    {
        var svc   = MakeService();
        var enc   = svc.Encrypt("hello");
        var parts = enc.Split(':');
        // Corrupt the tag (last part)
        var badTag  = Convert.ToBase64String(new byte[16]);
        var tampered = $"{parts[0]}:{parts[1]}:{parts[2]}:{badTag}";
        Assert.ThrowsAny<Exception>(() => svc.Decrypt(tampered));
    }

    [Fact]
    public void Decrypt_TamperedCiphertext_Throws()
    {
        var svc       = MakeService();
        var enc       = svc.Encrypt("hello");
        var parts     = enc["enc:".Length..].Split(':');
        var badCt     = Convert.ToBase64String(new byte[5]);
        var tampered  = $"enc:{parts[0]}:{badCt}:{parts[2]}";
        Assert.ThrowsAny<Exception>(() => svc.Decrypt(tampered));
    }

    // ── Error conditions ──────────────────────────────────────────────────────

    [Fact]
    public void Encrypt_NoKey_Throws()
    {
        var svc = MakeServiceNoKey();
        Assert.Throws<InvalidOperationException>(() => svc.Encrypt("secret"));
    }

    [Fact]
    public void Decrypt_NoKey_Throws()
    {
        var svc = MakeServiceNoKey();
        Assert.Throws<InvalidOperationException>(() => svc.Decrypt("enc:abc:def:ghi"));
    }

    [Fact]
    public void Decrypt_NotAnEnvelope_ThrowsFormat()
    {
        var svc = MakeService();
        Assert.Throws<FormatException>(() => svc.Decrypt("JBSWY3DPEHPK3PXP"));
    }

    [Fact]
    public void HasKey_TrueWhenKeyPresent()
    {
        Assert.True(MakeService().HasKey);
        Assert.False(MakeServiceNoKey().HasKey);
    }

    // ── Static helpers ────────────────────────────────────────────────────────

    [Theory]
    [InlineData("JBSWY3DPEHPK3PXP", true)]
    [InlineData("plaintextSecret",   true)]
    [InlineData("enc:abc:def:ghi",   false)]
    [InlineData(null,                false)]
    public void IsPlaintext_DetectsNonEncryptedValues(string? input, bool expected) =>
        Assert.Equal(expected, EncryptionService.IsPlaintext(input));
}
