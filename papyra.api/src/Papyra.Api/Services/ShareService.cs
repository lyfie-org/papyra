using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// ── ShareService ─────────────────────────────────────────────────────────────
// Manages share records stored at .system/shares/{shareId}.json.
// Maintains three in-memory indices (by id, by grantee, by public token)
public sealed class ShareService
{
    private readonly string _sharesDir;
    private readonly byte[] _signingKey;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy    = JsonNamingPolicy.CamelCase,
        WriteIndented           = true,
    };

    // id → record
    private readonly ConcurrentDictionary<string, ShareRecord> _byId    = new();
    // publicToken → record
    private readonly ConcurrentDictionary<string, ShareRecord> _byToken = new();

    public ShareService(IConfiguration config)
    {
        var storageRoot = config["Storage:StorageRoot"]
            ?? throw new InvalidOperationException("Storage:StorageRoot is not configured.");
        _sharesDir = Path.Combine(storageRoot, ".system", "shares");
        Directory.CreateDirectory(_sharesDir);

        // Derive a per-purpose signing key from PAPYRA_DATA_KEY so the HMAC key is
        // stable across restarts (public links survive server restarts).
        // If no key is set, fall back to a random key (links break on restart — safe).
        var keyEnv = Environment.GetEnvironmentVariable("PAPYRA_DATA_KEY");
        if (keyEnv is not null)
        {
            var masterKey = Convert.FromBase64String(keyEnv);
            using var kdf = new HMACSHA256(masterKey);
            _signingKey = kdf.ComputeHash(Encoding.UTF8.GetBytes("papyra-share-link-signing-v1"));
        }
        else
        {
            _signingKey = RandomNumberGenerator.GetBytes(32);
        }

        LoadAll();
    }

    // ── Boot load ──────────────────────────────────────────────────────────────

    private void LoadAll()
    {
        foreach (var file in Directory.EnumerateFiles(_sharesDir, "*.json"))
        {
            try
            {
                var text   = File.ReadAllText(file);
                var record = JsonSerializer.Deserialize<ShareRecord>(text, JsonOpts);
                if (record is null) continue;
                Index(record);
            }
            catch { /* corrupt share file — skip */ }
        }
    }

    private void Index(ShareRecord r)
    {
        _byId[r.ShareId] = r;
        if (r.PublicToken is not null) _byToken[r.PublicToken] = r;
    }

    private void Unindex(ShareRecord r)
    {
        _byId.TryRemove(r.ShareId, out _);
        if (r.PublicToken is not null) _byToken.TryRemove(r.PublicToken, out _);
    }

    // ── CRUD ───────────────────────────────────────────────────────────────────

    public IEnumerable<ShareRecord> GetSharesForNote(string noteId) =>
        _byId.Values.Where(r => r.NoteId == noteId);

    public IEnumerable<ShareRecord> GetSharesForGrantee(string username) =>
        _byId.Values.Where(r =>
            r.Grantee != null &&
            r.Grantee.Equals(username, StringComparison.OrdinalIgnoreCase) &&
            IsActive(r));

    public async Task<ShareRecord> CreateAsync(ShareRecord record)
    {
        var path = Path.Combine(_sharesDir, record.ShareId + ".json");
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(record, JsonOpts));
        Index(record);
        return record;
    }

    public async Task<bool> DeleteAsync(string shareId)
    {
        if (!_byId.TryGetValue(shareId, out var record)) return false;
        var path = Path.Combine(_sharesDir, shareId + ".json");
        if (File.Exists(path)) File.Delete(path);
        Unindex(record);
        return true;
    }

    // ── Permission checks (synchronous in-memory) ──────────────────────────────

    /// <summary>True if the user has any active share on this note.</summary>
    public bool IsGranted(string noteId, string username) =>
        _byId.Values.Any(r =>
            r.NoteId == noteId &&
            r.Grantee != null &&
            r.Grantee.Equals(username, StringComparison.OrdinalIgnoreCase) &&
            IsActive(r));

    /// <summary>True if the user has an active write share on this note.</summary>
    public bool IsWriteGranted(string noteId, string username) =>
        _byId.Values.Any(r =>
            r.NoteId == noteId &&
            r.Grantee != null &&
            r.Grantee.Equals(username, StringComparison.OrdinalIgnoreCase) &&
            r.Permission == "write" &&
            IsActive(r));

    private static bool IsActive(ShareRecord r) =>
        !r.ExpiresAt.HasValue || r.ExpiresAt.Value > DateTime.UtcNow;

    // ── Public link signing + validation ───────────────────────────────────────
    // Token = Base64Url(payload) + "." + Base64Url(HMACSHA256(key, payload))
    // payload = UTF8("{shareId}|{expiresAt.Ticks}")

    public string GeneratePublicToken(string shareId, DateTime expiresAt)
    {
        var payload = Encoding.UTF8.GetBytes($"{shareId}|{expiresAt.Ticks}");
        using var hmac = new HMACSHA256(_signingKey);
        var sig = hmac.ComputeHash(payload);
        return ToBase64Url(payload) + "." + ToBase64Url(sig);
    }

    /// <summary>Returns the share record if the token is valid and not expired; null otherwise.</summary>
    public ShareRecord? ValidatePublicToken(string token)
    {
        var dot = token.IndexOf('.');
        if (dot < 0) return null;

        try
        {
            var payload  = FromBase64Url(token[..dot]);
            var sigBytes = FromBase64Url(token[(dot + 1)..]);

            using var hmac = new HMACSHA256(_signingKey);
            var expected = hmac.ComputeHash(payload);
            if (!CryptographicOperations.FixedTimeEquals(sigBytes, expected)) return null;

            var text = Encoding.UTF8.GetString(payload);
            var sep  = text.IndexOf('|');
            if (sep < 0) return null;

            var shareId = text[..sep];
            if (!long.TryParse(text[(sep + 1)..], out var ticks)) return null;
            if (new DateTime(ticks, DateTimeKind.Utc) < DateTime.UtcNow) return null;

            return _byId.TryGetValue(shareId, out var record) ? record : null;
        }
        catch { return null; }
    }

    // ── Base64Url helpers ──────────────────────────────────────────────────────

    private static string ToBase64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        while (s.Length % 4 != 0) s += '=';
        return Convert.FromBase64String(s);
    }
}
