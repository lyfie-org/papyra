using System.Security.Cryptography;
using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// ── UserService ──────────────────────────────────────────────────────────────
// Manages user files at {storageRoot}/.system/users/{username}.json.
// Password hashing: bcrypt work-factor 12 (BCrypt.Net-Next).
// Transparent migration: existing pbkdf2$ hashes are verified and re-hashed
// to bcrypt on the next successful login.

public sealed class UserService
{
    private readonly string _usersDir;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public UserService(IConfiguration configuration)
    {
        var storageRoot = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _usersDir = Path.Combine(storageRoot, ".system", "users");
        Directory.CreateDirectory(_usersDir);
    }

    public bool IsInitialized() =>
        Directory.Exists(_usersDir) &&
        Directory.EnumerateFiles(_usersDir, "*.json")
            .Any(f => !f.EndsWith("_settings.json", StringComparison.OrdinalIgnoreCase));

    // Returns all user profile JSONs, excluding settings sidecars.
    public IEnumerable<string> GetAllUsernames() =>
        Directory.Exists(_usersDir)
            ? Directory.EnumerateFiles(_usersDir, "*.json")
                .Where(f => !f.EndsWith("_settings.json", StringComparison.OrdinalIgnoreCase))
                .Select(f => Path.GetFileNameWithoutExtension(f))
            : [];

    // Usernames may only contain alphanumeric chars, hyphens, underscores, and dots.
    // This prevents path-traversal: a username like "../../evil" must be rejected.
    public static bool IsValidUsername(string username) =>
        !string.IsNullOrWhiteSpace(username) &&
        username.Length is >= 1 and <= 50 &&
        username.All(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.');

    public async Task<UserModel?> GetUserAsync(string username)
    {
        var path = UserPath(username);
        if (!File.Exists(path)) return null;

        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return await JsonSerializer.DeserializeAsync<UserModel>(fs, JsonOpts);
        }
        finally { _lock.Release(); }
    }

    public async Task SaveUserAsync(UserModel user)
    {
        var path = UserPath(user.Username);
        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Create, FileAccess.Write, FileShare.None);
            await JsonSerializer.SerializeAsync(fs, user, JsonOpts);
        }
        finally { _lock.Release(); }
    }

    // Returns a bcrypt hash (work-factor 12). Use for all new password storage.
    public string HashPassword(string password) =>
        BCrypt.Net.BCrypt.HashPassword(password, workFactor: 12);

    // Verifies a candidate against a stored hash.
    // Supports both bcrypt ("$2...") and legacy PBKDF2 ("pbkdf2$...") hashes.
    public bool VerifyPassword(string candidate, string storedHash)
    {
        if (storedHash.StartsWith("$2", StringComparison.Ordinal))
            return BCrypt.Net.BCrypt.Verify(candidate, storedHash);

        if (storedHash.StartsWith("pbkdf2$", StringComparison.Ordinal))
            return VerifyPbkdf2(candidate, storedHash);

        return false;
    }

    // Returns true when the stored hash should be upgraded to bcrypt (legacy PBKDF2 format).
    public static bool NeedsRehash(string storedHash) =>
        storedHash.StartsWith("pbkdf2$", StringComparison.Ordinal);

    // ── Legacy PBKDF2 verification (migration support only) ──────────────────
    private static bool VerifyPbkdf2(string candidate, string storedHash)
    {
        var parts = storedHash.Split('$');
        if (parts.Length != 3 || parts[0] != "pbkdf2") return false;

        var salt         = Convert.FromBase64String(parts[1]);
        var expectedHash = Convert.FromBase64String(parts[2]);
        var hash         = Rfc2898DeriveBytes.Pbkdf2(
            candidate, salt, 100_000, HashAlgorithmName.SHA256, 32);

        return CryptographicOperations.FixedTimeEquals(hash, expectedHash);
    }

    private string UserPath(string username)
    {
        var safe = username.ToLowerInvariant();
        // Defense-in-depth: IsValidUsername is enforced at the endpoint layer, but we
        // also reject here so service-layer callers cannot bypass the check.
        if (!IsValidUsername(safe))
            throw new ArgumentException($"Username contains disallowed characters.", nameof(username));
        return Path.Combine(_usersDir, $"{safe}.json");
    }
}
