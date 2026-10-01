using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Papyra.Api.Storage;

/// <summary>
/// The password-sealed copy of a user's locked-note keys: what a plain backup
/// carries so its <c>vault/</c> can be opened on another server. Base64 fields.
/// </summary>
public sealed record LockedNoteKeyBundle(
    string Kdf, int Iterations, string Salt, string Nonce, string Tag, string Ciphertext);

/// <summary>
/// Encryption at rest for locked (<c>secure: true</c>) notes.
///
/// A locked note's title and body never sit on disk readable: the .md keeps its
/// frontmatter (id, tags, flags — what the grid needs to place it) and its body
/// becomes one line, <c>papyra-locked:v1:{kid}:{base64url}</c>. Everything that
/// copies the file — history, sync tools, the plain git mirror — copies only that.
///
/// Keys: each user has a keyring at <c>users/{uid}/.papyra/vault-keys.json</c>
/// holding random 64-byte keys (32 AES-256-GCM + 32 HMAC), each protected by
/// ASP.NET Data Protection (the instance key ring in <c>.papyra/keys</c>), so the
/// server reads and writes locked notes without anyone typing anything — autosave,
/// history and restore keep working. The same keys are also kept sealed under
/// PBKDF2(account password), refreshed whenever the person signs in with a new
/// password; that sealed bundle is what a plain backup carries.
///
/// Encryption is deterministic — nonce = HMAC(macKey, plaintext)[..12] — as in
/// <see cref="EncryptedGitCodec"/>: an unchanged note seals to the same bytes, so
/// history de-duplicates and a git mirror doesn't churn. An observer learns only
/// that two versions are equal.
///
/// The keyring is filesystem state, not a cache: lose it (or the instance key
/// ring) and the locked notes stay locked for good. Registered as a singleton.
/// </summary>
public sealed class LockedNoteCipher
{
    public const string Prefix = "papyra-locked:v1:";
    private const string FileName = "vault-keys.json";
    private const int KeySize = 64;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int Pbkdf2Iterations = EncryptedGitCodec.Pbkdf2Iterations;
    private static readonly byte[] BundleAad = "papyra-vault-keys:v1"u8.ToArray();

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly IDataProtector _protector;
    private readonly string _usersDir;
    private readonly ILogger<LockedNoteCipher> _logger;

    // Unprotected keyrings, invalidated whenever the file on disk changes (a
    // restore, an account deleted and its id reused).
    private readonly ConcurrentDictionary<string, (DateTime Mtime, Ring Ring)> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    private sealed class Ring
    {
        public string Primary = string.Empty;
        public Dictionary<string, byte[]> Keys = new(StringComparer.Ordinal);
    }

    // On-disk shape. Keys are Data-Protection-protected; Sealed is the password copy.
    private sealed record RingFile(
        int Version, string Primary, Dictionary<string, string> Keys,
        LockedNoteKeyBundle? Sealed, string? SealedFor);

    private sealed record Payload(string T, string B);

    public LockedNoteCipher(IDataProtectionProvider dataProtection, IConfiguration config, IHostEnvironment env,
        ILogger<LockedNoteCipher> logger)
    {
        _protector = dataProtection.CreateProtector("Papyra.LockedNoteKeys.v1");
        _usersDir = Path.GetFullPath(PapyraPaths.UsersDir(config, env.ContentRootPath));
        _logger = logger;
    }

    /// <summary>True when a note body is a sealed envelope rather than readable text.</summary>
    public static bool IsEnvelope(string? body)
    {
        if (string.IsNullOrEmpty(body)) return false;
        var s = body.AsSpan().Trim();
        return s.StartsWith(Prefix, StringComparison.Ordinal) && s.IndexOfAny(" \t\r\n") < 0;
    }

    /// <summary>
    /// The tenant a file belongs to, from where it lives (<c>users/{uid}/…</c>:
    /// notes, history, restore staging). Null for anything outside a user's dir.
    /// </summary>
    public string? UserFor(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var full = Path.GetFullPath(path);
        var root = _usersDir.EndsWith(Path.DirectorySeparatorChar) ? _usersDir : _usersDir + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            return null;
        var rest = full[root.Length..];
        var cut = rest.IndexOf(Path.DirectorySeparatorChar);
        var uid = cut > 0 ? rest[..cut] : null;
        return string.IsNullOrEmpty(uid) || uid.StartsWith('.') ? null : uid;
    }

    /// <summary>Seal a locked note's title and body under the user's current key.</summary>
    public string Seal(string uid, string title, string body)
    {
        var ring = LoadOrCreate(uid);
        var key = ring.Keys[ring.Primary];
        var plain = JsonSerializer.SerializeToUtf8Bytes(new Payload(title, body));
        try
        {
            var nonce = HMACSHA256.HashData(key.AsSpan(32), plain)[..NonceSize];
            var output = new byte[NonceSize + TagSize + plain.Length];
            nonce.CopyTo(output, 0);
            using (var gcm = new AesGcm(key.AsSpan(0, 32), TagSize))
                gcm.Encrypt(nonce, plain, output.AsSpan(NonceSize + TagSize), output.AsSpan(NonceSize, TagSize), Aad(ring.Primary));
            return $"{Prefix}{ring.Primary}:{Base64Url(output)}";
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    /// <summary>Open an envelope with the user's keyring. False when it isn't theirs or was altered.</summary>
    public bool TryOpen(string uid, string envelope, out string title, out string body)
    {
        title = body = string.Empty;
        Ring? ring;
        try { ring = Load(uid); }
        catch (Exception ex) when (ex is IOException or CryptographicException or JsonException or FormatException)
        {
            _logger.LogWarning(ex, "Locked-note keyring for user {Uid} is unreadable", uid);
            return false;
        }
        return ring is not null && TryOpen(ring.Keys, envelope, out title, out body);
    }

    /// <summary>Open an envelope with explicit keys (a backup's bundle, unsealed).</summary>
    public static bool TryOpen(IReadOnlyDictionary<string, byte[]> keys, string envelope, out string title, out string body)
    {
        title = body = string.Empty;
        var s = envelope.Trim();
        if (!s.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        var rest = s[Prefix.Length..];
        var colon = rest.IndexOf(':');
        if (colon <= 0) return false;
        var kid = rest[..colon];
        if (!keys.TryGetValue(kid, out var key)) return false;
        byte[] data;
        try { data = FromBase64Url(rest[(colon + 1)..]); }
        catch (FormatException) { return false; }
        if (data.Length < NonceSize + TagSize) return false;
        var plain = new byte[data.Length - NonceSize - TagSize];
        try
        {
            using (var gcm = new AesGcm(key.AsSpan(0, 32), TagSize))
                gcm.Decrypt(data.AsSpan(0, NonceSize), data.AsSpan(NonceSize + TagSize), data.AsSpan(NonceSize, TagSize), plain, Aad(kid));
            var payload = JsonSerializer.Deserialize<Payload>(plain);
            if (payload is null) return false;
            title = payload.T ?? string.Empty;
            body = payload.B ?? string.Empty;
            return true;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException) { return false; }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    /// <summary>Whether this user has ever had a keyring (i.e. has, or had, locked notes).</summary>
    public bool HasKeys(string uid) => File.Exists(RingPath(uid));

    /// <summary>
    /// Keep the password-sealed copy of the keys current. Called where the
    /// account password is in hand (sign-in, password change). Cheap unless the
    /// password changed since the last seal — then one PBKDF2 derivation.
    /// No keyring yet → nothing to seal.
    /// </summary>
    public void EnsureSealed(string uid, string password, string passwordHash)
    {
        if (!HasKeys(uid) || string.IsNullOrEmpty(password)) return;
        var sem = _locks.GetOrAdd(uid, _ => new SemaphoreSlim(1, 1));
        sem.Wait();
        try
        {
            var file = ReadFile(uid);
            var ring = Load(uid);
            if (file is null || ring is null) return;
            var fingerprint = Fingerprint(passwordHash);
            if (file.Sealed is not null && file.SealedFor == fingerprint) return;
            WriteFile(uid, file with { Sealed = SealBundle(ring.Keys, password), SealedFor = fingerprint });
        }
        catch (Exception ex) when (ex is IOException or CryptographicException or JsonException)
        {
            _logger.LogWarning(ex, "Could not seal the locked-note keys for user {Uid}", uid);
        }
        finally { sem.Release(); }
    }

    /// <summary>The password-sealed bundle a plain backup carries, or null when none has been made yet.</summary>
    public LockedNoteKeyBundle? SealedBundle(string uid) => ReadFile(uid)?.Sealed;

    /// <summary>Recover a bundle's keys. Throws <see cref="CryptographicException"/> on a wrong password.</summary>
    public static Dictionary<string, byte[]> OpenBundle(LockedNoteKeyBundle bundle, string password)
    {
        if (bundle.Iterations is < 100_000 or > 10_000_000) throw new CryptographicException("Unsupported key derivation.");
        var kek = Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromBase64String(bundle.Salt), bundle.Iterations, HashAlgorithmName.SHA256, 32);
        var cipher = Convert.FromBase64String(bundle.Ciphertext);
        var plain = new byte[cipher.Length];
        try
        {
            using (var gcm = new AesGcm(kek, TagSize))
                gcm.Decrypt(Convert.FromBase64String(bundle.Nonce), cipher, Convert.FromBase64String(bundle.Tag), plain, BundleAad);
            var map = JsonSerializer.Deserialize<Dictionary<string, string>>(plain)
                      ?? throw new CryptographicException("Empty key bundle.");
            var keys = map.ToDictionary(kv => kv.Key, kv => Convert.FromBase64String(kv.Value), StringComparer.Ordinal);
            if (keys.Values.Any(k => k.Length != KeySize)) throw new CryptographicException("Bad key length.");
            return keys;
        }
        catch (JsonException ex) { throw new CryptographicException("Damaged key bundle.", ex); }
        finally
        {
            CryptographicOperations.ZeroMemory(kek);
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────────

    private string RingPath(string uid) => Path.Combine(_usersDir, uid, ".papyra", FileName);

    private static byte[] Aad(string kid) => Encoding.UTF8.GetBytes(Prefix + kid);

    private static string Fingerprint(string passwordHash) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("papyra-vault-seal:" + passwordHash)));

    private static LockedNoteKeyBundle SealBundle(Dictionary<string, byte[]> keys, string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var kek = Rfc2898DeriveBytes.Pbkdf2(password, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256, 32);
        var plain = JsonSerializer.SerializeToUtf8Bytes(keys.ToDictionary(kv => kv.Key, kv => Convert.ToBase64String(kv.Value)));
        try
        {
            var nonce = RandomNumberGenerator.GetBytes(NonceSize);
            var tag = new byte[TagSize];
            var cipher = new byte[plain.Length];
            using (var gcm = new AesGcm(kek, TagSize))
                gcm.Encrypt(nonce, plain, cipher, tag, BundleAad);
            return new LockedNoteKeyBundle("PBKDF2-SHA256", Pbkdf2Iterations, Convert.ToBase64String(salt),
                Convert.ToBase64String(nonce), Convert.ToBase64String(tag), Convert.ToBase64String(cipher));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(kek);
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    private RingFile? ReadFile(string uid)
    {
        var path = RingPath(uid);
        if (!File.Exists(path)) return null;
        return JsonSerializer.Deserialize<RingFile>(File.ReadAllText(path), Json);
    }

    // Atomic, like every other write: tmp → fsync → replace.
    private void WriteFile(string uid, RingFile file)
    {
        var path = RingPath(uid);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + $".{Guid.NewGuid():N}.tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(JsonSerializer.SerializeToUtf8Bytes(file, Json));
            fs.Flush(flushToDisk: true);
        }
        File.Move(tmp, path, overwrite: true);
        _cache.TryRemove(uid, out _);
    }

    private Ring? Load(string uid)
    {
        var path = RingPath(uid);
        if (!File.Exists(path)) { _cache.TryRemove(uid, out _); return null; }
        var mtime = File.GetLastWriteTimeUtc(path);
        if (_cache.TryGetValue(uid, out var hit) && hit.Mtime == mtime) return hit.Ring;

        var file = ReadFile(uid) ?? throw new CryptographicException("Unreadable locked-note keyring.");
        var ring = new Ring { Primary = file.Primary };
        foreach (var (kid, protectedKey) in file.Keys)
            ring.Keys[kid] = _protector.Unprotect(Convert.FromBase64String(protectedKey));
        if (!ring.Keys.ContainsKey(ring.Primary)) throw new CryptographicException("Locked-note keyring has no primary key.");
        _cache[uid] = (mtime, ring);
        return ring;
    }

    private Ring LoadOrCreate(string uid)
    {
        if (Load(uid) is { } ring) return ring;
        var sem = _locks.GetOrAdd(uid, _ => new SemaphoreSlim(1, 1));
        sem.Wait();
        try
        {
            if (Load(uid) is { } raced) return raced;
            var kid = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));
            var key = RandomNumberGenerator.GetBytes(KeySize);
            WriteFile(uid, new RingFile(1, kid,
                new Dictionary<string, string> { [kid] = Convert.ToBase64String(_protector.Protect(key)) },
                Sealed: null, SealedFor: null));
            _logger.LogInformation("Created the locked-note keyring for user {Uid}", uid);
            return Load(uid)!;
        }
        finally { sem.Release(); }
    }

    private static string Base64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string s)
    {
        var b = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(b + new string('=', (4 - b.Length % 4) % 4));
    }
}
