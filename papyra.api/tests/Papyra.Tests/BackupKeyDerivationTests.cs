using System.Security.Cryptography;

namespace Papyra.Tests;

// The vault key derivation is part of the ON-DISK FORMAT: change it and every
// existing .papyra-vault becomes undecryptable. This pins it to a known-good
// PBKDF2-HMAC-SHA256 vector (independently computed, RFC 2898), so any future
// refactor of DeriveKey that alters the output fails here instead of silently
// orphaning users' backups.
public sealed class BackupKeyDerivationTests
{
    private const string Password = "correct horse battery staple";
    private const int Iterations = 600_000;   // must mirror EncryptedBackupService
    private const int KeySize = 32;           // AES-256
    private const string ExpectedKeyHex =
        "EF177144EEC9420CBC1093D2A8B344A92BC506D0D4EC9C028DD19F8324D8C1E6";

    private static byte[] Salt => [.. Enumerable.Range(0, 16).Select(i => (byte)i)];

    [Fact]
    public void Pbkdf2_MatchesTheStandardVector()
    {
        var key = Rfc2898DeriveBytes.Pbkdf2(
            Password, Salt, Iterations, HashAlgorithmName.SHA256, KeySize);

        Assert.Equal(ExpectedKeyHex, Convert.ToHexString(key));
    }

    // Note: when this moved off the obsolete Rfc2898DeriveBytes constructor
    // (SYSLIB0060) the two APIs were verified to derive byte-identical keys, so
    // vaults written by earlier builds still open. The vector above is what
    // actually guarantees that going forward — it's independent of which API
    // computes it.
}
