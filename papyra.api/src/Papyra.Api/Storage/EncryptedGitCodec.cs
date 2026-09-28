using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Storage;

/// <summary>
/// How an encrypted git backup's data key is protected, stored in its
/// <c>papyra-backup.json</c>: the key sealed under one derived from the account
/// password. Everything is base64.
/// </summary>
public sealed record EncryptedGitHeader(
    string Kdf, int Iterations, string Salt, string Nonce, string Tag, string WrappedKey);

/// <summary>
/// File-by-file encryption for a git backup repository.
///
/// Why not push the .papyra-vault blob: git would store a new, incompressible
/// copy of the whole vault on every sync. Here each file is sealed on its own
/// and <em>deterministically</em> — same key, same path, same bytes → same
/// ciphertext — so an unchanged note produces no diff and the repository grows
/// only by what actually changed. The cost is that an observer can tell a file
/// did not change; they cannot tell what it says or what it is called.
///
/// Keys: a random 64-byte data key (32 bytes AES-256-GCM + 32 bytes HMAC). It is
/// stored on this server (protected by ASP.NET Data Protection) so the half-hourly
/// sync can run without anyone typing a password, and in the repository sealed
/// under PBKDF2(account password). Changing the password re-seals the data key;
/// nothing else in the repository changes.
///
/// A sealed file: "PGE1" | nonce (12) | tag (16) | ciphertext of
/// [u16 path length][path (UTF-8)][content]. The nonce is
/// HMAC(macKey, path ‖ SHA-256(content))[..12] — it changes whenever the content
/// does, which is what makes deterministic GCM safe. The stored file name is
/// HMAC(macKey, path), so names reveal nothing but the folder kept for
/// orientation (notes/, vault/, media/images/, …).
/// </summary>
public static class EncryptedGitCodec
{
    public const int Pbkdf2Iterations = 600_000;
    private const int DataKeySize = 64;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private static readonly byte[] Magic = "PGE1"u8.ToArray();
    public const string Extension = ".enc";

    public static byte[] NewDataKey() => RandomNumberGenerator.GetBytes(DataKeySize);

    /// <summary>Seal <paramref name="dataKey"/> under the password for the repository header.</summary>
    public static EncryptedGitHeader Wrap(byte[] dataKey, string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var kek = Rfc2898DeriveBytes.Pbkdf2(password, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256, 32);
        try
        {
            var nonce = RandomNumberGenerator.GetBytes(NonceSize);
            var tag = new byte[TagSize];
            var cipher = new byte[dataKey.Length];
            using var gcm = new AesGcm(kek, TagSize);
            gcm.Encrypt(nonce, dataKey, cipher, tag, Magic);
            return new EncryptedGitHeader("PBKDF2-SHA256", Pbkdf2Iterations,
                Convert.ToBase64String(salt), Convert.ToBase64String(nonce), Convert.ToBase64String(tag), Convert.ToBase64String(cipher));
        }
        finally { CryptographicOperations.ZeroMemory(kek); }
    }

    /// <summary>Recover the data key. Throws <see cref="CryptographicException"/> on a wrong password.</summary>
    public static byte[] Unwrap(EncryptedGitHeader header, string password)
    {
        if (header.Iterations is < 100_000 or > 10_000_000) throw new CryptographicException("Unsupported key derivation.");
        var kek = Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromBase64String(header.Salt), header.Iterations, HashAlgorithmName.SHA256, 32);
        try
        {
            var cipher = Convert.FromBase64String(header.WrappedKey);
            if (cipher.Length != DataKeySize) throw new CryptographicException("Bad key length.");
            var key = new byte[cipher.Length];
            using var gcm = new AesGcm(kek, TagSize);
            gcm.Decrypt(Convert.FromBase64String(header.Nonce), cipher, Convert.FromBase64String(header.Tag), key, Magic);
            return key;
        }
        finally { CryptographicOperations.ZeroMemory(kek); }
    }

    /// <summary>
    /// The folder a sealed file is kept under: the backup's top-level folder, plus
    /// the media category (media/images, …). Everything below that is hidden.
    /// </summary>
    public static string VisibleFolder(string relPath)
    {
        var parts = relPath.Split('/');
        if (parts.Length >= 3 && parts[0] == "media") return $"media/{parts[1]}";
        return parts.Length >= 2 ? parts[0] : string.Empty;
    }

    /// <summary>Seal every file of <paramref name="plainRoot"/> (a <see cref="BackupLayout"/> tree) into <paramref name="destRoot"/>.</summary>
    public static void EncryptTree(string plainRoot, string destRoot, byte[] dataKey)
    {
        var (encKey, macKey) = Split(dataKey);
        using var gcm = new AesGcm(encKey, TagSize);
        foreach (var file in Directory.EnumerateFiles(plainRoot, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(plainRoot, file).Replace('\\', '/');
            // The manifest and readme are written in the clear by the caller.
            if (rel is BackupManifest.FileName or "README.md") continue;
            var sealedBytes = Seal(gcm, macKey, rel, File.ReadAllBytes(file));
            var folder = VisibleFolder(rel);
            var name = Convert.ToHexStringLower(HMACSHA256.HashData(macKey, Encoding.UTF8.GetBytes("name\0" + rel)))[..32] + Extension;
            var dest = Path.Combine(destRoot, folder, name);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.WriteAllBytes(dest, sealedBytes);
        }
    }

    /// <summary>
    /// Open every sealed file under <paramref name="encRoot"/> back into a plain
    /// backup tree at <paramref name="destRoot"/>. Throws
    /// <see cref="CryptographicException"/> if any file was tampered with.
    /// </summary>
    public static int DecryptTree(string encRoot, string destRoot, byte[] dataKey)
    {
        var (encKey, _) = Split(dataKey);
        using var gcm = new AesGcm(encKey, TagSize);
        var destFull = Path.GetFullPath(destRoot) + Path.DirectorySeparatorChar;
        var count = 0;
        foreach (var file in Directory.EnumerateFiles(encRoot, "*" + Extension, SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}.git{Path.DirectorySeparatorChar}")) continue;
            var (rel, content) = Open(gcm, File.ReadAllBytes(file));
            // The path came out of an authenticated envelope, but it is still a
            // path from outside: keep it inside the destination.
            var target = Path.GetFullPath(Path.Combine(destRoot, rel));
            if (!target.StartsWith(destFull, StringComparison.Ordinal)) throw new CryptographicException("Path escapes the backup.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllBytes(target, content);
            count++;
        }
        return count;
    }

    private static byte[] Seal(AesGcm gcm, byte[] macKey, string rel, byte[] content)
    {
        var path = Encoding.UTF8.GetBytes(rel);
        var plain = new byte[2 + path.Length + content.Length];
        plain[0] = (byte)(path.Length >> 8);
        plain[1] = (byte)path.Length;
        path.CopyTo(plain, 2);
        content.CopyTo(plain, 2 + path.Length);

        var nonceInput = new byte[path.Length + 32];
        path.CopyTo(nonceInput, 0);
        SHA256.HashData(content).CopyTo(nonceInput, path.Length);
        var nonce = HMACSHA256.HashData(macKey, nonceInput)[..NonceSize];

        var output = new byte[Magic.Length + NonceSize + TagSize + plain.Length];
        Magic.CopyTo(output, 0);
        nonce.CopyTo(output, Magic.Length);
        gcm.Encrypt(nonce, plain,
            output.AsSpan(Magic.Length + NonceSize + TagSize),
            output.AsSpan(Magic.Length + NonceSize, TagSize), Magic);
        CryptographicOperations.ZeroMemory(plain);
        return output;
    }

    private static (string Rel, byte[] Content) Open(AesGcm gcm, byte[] sealedBytes)
    {
        if (sealedBytes.Length < Magic.Length + NonceSize + TagSize + 2 || !sealedBytes.AsSpan(0, Magic.Length).SequenceEqual(Magic))
            throw new CryptographicException("Not a Papyra encrypted file.");
        var nonce = sealedBytes.AsSpan(Magic.Length, NonceSize);
        var tag = sealedBytes.AsSpan(Magic.Length + NonceSize, TagSize);
        var cipher = sealedBytes.AsSpan(Magic.Length + NonceSize + TagSize);
        var plain = new byte[cipher.Length];
        gcm.Decrypt(nonce, cipher, tag, plain, Magic);
        var pathLen = (plain[0] << 8) | plain[1];
        if (pathLen == 0 || 2 + pathLen > plain.Length) throw new CryptographicException("Corrupt file header.");
        var rel = Encoding.UTF8.GetString(plain, 2, pathLen);
        return (rel, plain[(2 + pathLen)..]);
    }

    private static (byte[] Enc, byte[] Mac) Split(byte[] dataKey)
    {
        if (dataKey.Length != DataKeySize) throw new CryptographicException("Bad data key.");
        return (dataKey[..32], dataKey[32..]);
    }
}
