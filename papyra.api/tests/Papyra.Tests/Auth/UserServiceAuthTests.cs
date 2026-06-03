using Microsoft.Extensions.Configuration;
using Papyra.Api.Services;

namespace Papyra.Tests.Auth;

public sealed class UserServiceAuthTests
{
    private static UserService MakeService()
    {
        var dir    = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:StorageRoot"] = dir,
            })
            .Build();
        return new UserService(config);
    }

    // ── Bcrypt hashing ────────────────────────────────────────────────────────

    [Fact]
    public void HashPassword_Produces_BcryptFormat()
    {
        var svc  = MakeService();
        var hash = svc.HashPassword("correct-horse-battery-staple");
        Assert.StartsWith("$2", hash);
    }

    [Fact]
    public void VerifyPassword_BcryptHash_Succeeds()
    {
        var svc = MakeService();
        var pw  = "my-password";
        var hash = svc.HashPassword(pw);
        Assert.True(svc.VerifyPassword(pw, hash));
    }

    [Fact]
    public void VerifyPassword_WrongPassword_Fails()
    {
        var svc  = MakeService();
        var hash = svc.HashPassword("right");
        Assert.False(svc.VerifyPassword("wrong", hash));
    }

    // ── Legacy PBKDF2 migration ───────────────────────────────────────────────

    [Fact]
    public void VerifyPassword_LegacyPbkdf2Hash_Succeeds()
    {
        // Simulate a hash produced by the old PBKDF2 code
        var salt = new byte[16];
        var hash = System.Security.Cryptography.Rfc2898DeriveBytes.Pbkdf2(
            "legacy-pass", salt, 100_000,
            System.Security.Cryptography.HashAlgorithmName.SHA256, 32);
        var stored = $"pbkdf2${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";

        var svc = MakeService();
        Assert.True(svc.VerifyPassword("legacy-pass", stored));
        Assert.False(svc.VerifyPassword("wrong", stored));
    }

    [Fact]
    public void NeedsRehash_PbkdF2_True()
    {
        Assert.True(UserService.NeedsRehash("pbkdf2$salt$hash"));
    }

    [Fact]
    public void NeedsRehash_Bcrypt_False()
    {
        var svc  = MakeService();
        var hash = svc.HashPassword("pw");
        Assert.False(UserService.NeedsRehash(hash));
    }

    // ── Unknown format ────────────────────────────────────────────────────────

    [Fact]
    public void VerifyPassword_UnknownFormat_ReturnsFalse()
    {
        var svc = MakeService();
        Assert.False(svc.VerifyPassword("pass", "sha1:somegarbagehere"));
    }
}
