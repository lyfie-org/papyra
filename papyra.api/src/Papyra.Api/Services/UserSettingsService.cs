using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// Persists per-user settings at {storageRoot}/.system/users/{username}_settings.json.
public sealed class UserSettingsService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    private readonly string _usersDir;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public UserSettingsService(IConfiguration configuration)
    {
        var storageRoot = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _usersDir = Path.Combine(storageRoot, ".system", "users");
        Directory.CreateDirectory(_usersDir);
    }

    public async Task<UserSettingsModel> GetSettingsAsync(string username)
    {
        var path = SettingsPath(username);
        if (!File.Exists(path)) return new UserSettingsModel();

        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return await JsonSerializer.DeserializeAsync<UserSettingsModel>(fs, JsonOpts)
                   ?? new UserSettingsModel();
        }
        finally { _lock.Release(); }
    }

    public async Task SaveSettingsAsync(string username, UserSettingsModel settings)
    {
        var path = SettingsPath(username);
        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Create, FileAccess.Write, FileShare.None);
            await JsonSerializer.SerializeAsync(fs, settings, JsonOpts);
        }
        finally { _lock.Release(); }
    }

    private string SettingsPath(string username)
    {
        var safe = username.ToLowerInvariant();
        if (!UserService.IsValidUsername(safe))
            throw new ArgumentException($"Username contains disallowed characters.", nameof(username));
        return Path.Combine(_usersDir, $"{safe}_settings.json");
    }
}
