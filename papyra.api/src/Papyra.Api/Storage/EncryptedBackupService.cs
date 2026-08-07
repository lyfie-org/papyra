using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

namespace Papyra.Api.Storage;

// Password-derived, AES-GCM encrypted vault backups. The plaintext is a ZIP of the
// caller's notes/ + media/ trees; the archive is built on a temp file and streamed
// through fixed-size GCM frames, so we never hold the whole vault in RAM (multi-GB
// vaults stay bounded). AesGcm isn't a CryptoStream cipher in .NET, so we frame it
// ourselves: each frame is independently sealed and the per-frame length is fed in
// as associated data, so a truncated or reordered file fails the tag check.
//
// .papyra-vault layout:
//   magic   "PAPYRAV1" (8 bytes)
//   salt    16 bytes               (PBKDF2)
//   then frames until EOF:
//     nonce   12 bytes
//     length  4 bytes  (int32 little-endian: plaintext bytes in this frame)
//     tag     16 bytes
//     cipher  {length} bytes
public sealed class EncryptedBackupService
{
    private const int Pbkdf2Iterations = 600_000;
    private const int SaltSize = 16;
    private const int KeySize = 32;        // AES-256
    private const int NonceSize = 12;      // AesGcm.NonceByteSizes.MaxSize
    private const int TagSize = 16;        // AesGcm.TagByteSizes.MaxSize
    private const int FrameSize = 1 << 20; // 1 MiB plaintext per frame
    private static readonly byte[] Magic = "PAPYRAV1"u8.ToArray();

    // Zip the labelled source dirs, then stream the archive out encrypted under a
    // key derived from masterPassword. Each source's files land under its label
    // (e.g. "notes/foo.md", "media/bar.png").
    public async Task BackupAsync(
        IEnumerable<(string Label, string Dir)> sources, string masterPassword,
        Stream destination, CancellationToken ct)
    {
        var tmpZip = Path.Combine(Path.GetTempPath(), $"papyra-vault-{Guid.NewGuid():N}.zip");
        try
        {
            // 1. Build the plaintext archive on disk (never buffered in RAM).
            await using (var zipFs = new FileStream(tmpZip, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var zip = new ZipArchive(zipFs, ZipArchiveMode.Create))
            {
                foreach (var (label, dir) in sources)
                {
                    if (!Directory.Exists(dir)) continue;
                    foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        var rel = Path.GetRelativePath(dir, file).Replace('\\', '/');
                        var entry = zip.CreateEntry($"{label}/{rel}", CompressionLevel.Fastest);
                        await using var es = entry.Open();
                        await using var src = File.OpenRead(file);
                        await src.CopyToAsync(es, ct);
                    }
                }
            }

            // 2. Derive the key and emit the header.
            var salt = RandomNumberGenerator.GetBytes(SaltSize);
            var key = DeriveKey(masterPassword, salt);
            try
            {
                await destination.WriteAsync(Magic, ct);
                await destination.WriteAsync(salt, ct);

                // 3. Seal the archive frame by frame.
                using var gcm = new AesGcm(key, TagSize);
                var plain = new byte[FrameSize];
                var cipher = new byte[FrameSize];
                var nonce = new byte[NonceSize];
                var tag = new byte[TagSize];
                var lenBuf = new byte[4];

                await using var zipRead = new FileStream(tmpZip, FileMode.Open, FileAccess.Read, FileShare.None);
                int read;
                while ((read = await ReadUpToAsync(zipRead, plain, ct)) > 0)
                {
                    RandomNumberGenerator.Fill(nonce);
                    BinaryPrimitives.WriteInt32LittleEndian(lenBuf, read);
                    gcm.Encrypt(nonce, plain.AsSpan(0, read), cipher.AsSpan(0, read), tag, lenBuf);
                    await destination.WriteAsync(nonce, ct);
                    await destination.WriteAsync(lenBuf, ct);
                    await destination.WriteAsync(tag, ct);
                    await destination.WriteAsync(cipher.AsMemory(0, read), ct);
                }
            }
            finally { CryptographicOperations.ZeroMemory(key); }
        }
        finally
        {
            if (File.Exists(tmpZip)) File.Delete(tmpZip);
        }
    }

    // Decrypt a vault stream and extract its trees into destinationRoot (which ends
    // up holding notes/ + media/). Throws CryptographicException on a wrong password
    // or tampered file, InvalidDataException on a non-vault / truncated file.
    public async Task RestoreAsync(Stream source, string masterPassword, string destinationRoot, CancellationToken ct)
    {
        var magic = new byte[Magic.Length];
        await ReadExactAsync(source, magic, ct);
        if (!magic.AsSpan().SequenceEqual(Magic))
            throw new InvalidDataException("Not a Papyra vault file.");

        var salt = new byte[SaltSize];
        await ReadExactAsync(source, salt, ct);
        var key = DeriveKey(masterPassword, salt);

        var tmpZip = Path.Combine(Path.GetTempPath(), $"papyra-restore-{Guid.NewGuid():N}.zip");
        try
        {
            using (var gcm = new AesGcm(key, TagSize))
            await using (var zipFs = new FileStream(tmpZip, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var nonce = new byte[NonceSize];
                var tag = new byte[TagSize];
                var lenBuf = new byte[4];
                while (true)
                {
                    // A clean EOF lands exactly on a frame boundary (0 bytes read).
                    var got = await ReadUpToAsync(source, nonce, ct);
                    if (got == 0) break;
                    if (got < NonceSize) throw new InvalidDataException("Truncated vault file.");

                    await ReadExactAsync(source, lenBuf, ct);
                    await ReadExactAsync(source, tag, ct);
                    var len = BinaryPrimitives.ReadInt32LittleEndian(lenBuf);
                    if (len <= 0 || len > FrameSize) throw new InvalidDataException("Corrupt vault frame.");

                    var cipher = new byte[len];
                    await ReadExactAsync(source, cipher, ct);
                    var plain = new byte[len];
                    gcm.Decrypt(nonce, cipher, tag, plain, lenBuf); // throws on bad key/tamper
                    await zipFs.WriteAsync(plain.AsMemory(0, len), ct);
                }
            }
            CryptographicOperations.ZeroMemory(key);
            ZipFile.ExtractToDirectory(tmpZip, destinationRoot, overwriteFiles: true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            if (File.Exists(tmpZip)) File.Delete(tmpZip);
        }
    }

    // PBKDF2-HMAC-SHA256. This is part of the on-disk vault format — changing the
    // algorithm, iteration count or output size orphans every existing backup, so
    // BackupKeyDerivationTests pins it to a known vector.
    private static byte[] DeriveKey(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256, KeySize);

    // Read up to buffer.Length bytes; returns the count actually read (short only at
    // EOF). Streams may hand back partial reads, so loop until full or exhausted.
    private static async Task<int> ReadUpToAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(total), ct);
            if (n == 0) break;
            total += n;
        }
        return total;
    }

    private static async Task ReadExactAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        if (await ReadUpToAsync(stream, buffer, ct) != buffer.Length)
            throw new InvalidDataException("Truncated vault file.");
    }
}
