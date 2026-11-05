using System.Runtime.CompilerServices;
using Papyra.Api.Security;

namespace Papyra.Tests;

/// <summary>
/// Every test boots an app and signs in, so BCrypt at its real cost would be most of the
/// suite's time. The test process asks for the cheapest cost before anything is hashed;
/// the stored hash carries its own cost, so verifying behaves exactly as in production.
/// </summary>
internal static class CheapHashing
{
    [ModuleInitializer]
    internal static void Use()
    {
        // A value already in the environment wins, so a run can be pointed at the real
        // cost (set it empty) to compare.
        if (Environment.GetEnvironmentVariable("PAPYRA_TEST_BCRYPT_COST") is null)
            Environment.SetEnvironmentVariable("PAPYRA_TEST_BCRYPT_COST", "4");
    }
}

public class SecretHasherTests
{
    [Fact]
    public void TheTestRun_HashesAtTheCheapCost()
    {
        Assert.Equal(4, SecretHasher.CostOverride);
        Assert.StartsWith("$2a$04$", SecretHasher.HashPassword("a long enough password"));
        Assert.StartsWith("$2a$04$", SecretHasher.Hash("123456", 12));
    }

    [Fact]
    public void AHashMadeAtAnotherCost_StillVerifies()
    {
        // What a real install holds: hashes made at the full cost, read back by a build
        // that is hashing cheaply. The cost is part of the hash, not the verifier.
        var real = BCrypt.Net.BCrypt.HashPassword("a long enough password", 12);
        Assert.StartsWith("$2a$12$", real);
        Assert.True(BCrypt.Net.BCrypt.Verify("a long enough password", real));
        Assert.False(BCrypt.Net.BCrypt.Verify("another password", real));
    }
}
