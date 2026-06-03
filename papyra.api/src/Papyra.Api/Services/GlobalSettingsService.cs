using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// ── GlobalSettingsService ─────────────────────────────────────────────────────
// Manages instance-wide settings at {storageRoot}/.system/settings.json.

public sealed class GlobalSettingsService
{
    private readonly string _settingsPath;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public GlobalSettingsService(IConfiguration configuration)
    {
        var storageRoot = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");

        var systemDir = Path.Combine(storageRoot, ".system");
        Directory.CreateDirectory(systemDir);
        _settingsPath = Path.Combine(systemDir, "settings.json");
    }

    public async Task<GlobalSettingsModel> GetAsync()
    {
        await _lock.WaitAsync();
        try { return await ReadUnlockedAsync(); }
        finally { _lock.Release(); }
    }

    public async Task SaveAsync(GlobalSettingsModel settings)
    {
        await _lock.WaitAsync();
        try { await WriteUnlockedAsync(settings); }
        finally { _lock.Release(); }
    }

    // Holds the lock for the entire read→mutate→write cycle to eliminate the TOCTOU
    // race that existed when GetAsync and SaveAsync were called sequentially.
    public async Task<GlobalSettingsModel> UpdateAsync(Action<GlobalSettingsModel> mutate)
    {
        await _lock.WaitAsync();
        try
        {
            var current = await ReadUnlockedAsync();
            mutate(current);
            await WriteUnlockedAsync(current);
            return current;
        }
        finally { _lock.Release(); }
    }

    // ── Helpers (must only be called while _lock is held) ──────────────────────

    private async Task<GlobalSettingsModel> ReadUnlockedAsync()
    {
        if (!File.Exists(_settingsPath)) return new GlobalSettingsModel();
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                await using var fs = new FileStream(
                    _settingsPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                return await JsonSerializer.DeserializeAsync<GlobalSettingsModel>(fs, JsonOpts)
                       ?? new GlobalSettingsModel();
            }
            catch (IOException) when (attempt < 4) { await Task.Delay(80); }
        }
        return new GlobalSettingsModel();
    }

    private async Task WriteUnlockedAsync(GlobalSettingsModel settings)
    {
        await using var fs = new FileStream(
            _settingsPath, FileMode.Create, FileAccess.Write, FileShare.None);
        await JsonSerializer.SerializeAsync(fs, settings, JsonOpts);
    }
}
