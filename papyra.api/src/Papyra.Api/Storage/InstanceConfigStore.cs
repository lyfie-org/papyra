using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Instance-wide configuration an admin edits from the UI, stored as AppSetting
// rows rather than appsettings.json.
//
// Why not configuration files: a self-hoster running the published container has
// no practical way to edit appsettings.json or add environment variables without
// rebuilding or recreating the container. Anything they are expected to *set up*
// — SSO, outbound mail — therefore has to be editable from inside the app.
//
// Values are cached in memory and re-read only when a write bumps the version,
// so the auth handler and the mail sender can consult this on every request
// without hitting SQLite each time. `Version` is what callers watch to know
// their derived state (e.g. cached OIDC options) is stale.
public sealed class InstanceConfigStore
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<InstanceConfigStore> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private Dictionary<string, string?> _cache = new(StringComparer.Ordinal);
    private bool _loaded;

    /// <summary>Bumped on every successful write. Watch it to invalidate derived state.</summary>
    public int Version { get; private set; }

    public InstanceConfigStore(IServiceScopeFactory scopes, ILogger<InstanceConfigStore> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    /// <summary>
    /// Load once from the database. Safe to call repeatedly; only the first call
    /// (and any call after <see cref="Invalidate"/>) touches SQLite.
    /// </summary>
    public async Task EnsureLoadedAsync(CancellationToken ct = default)
    {
        if (_loaded) return;
        await _gate.WaitAsync(ct);
        try
        {
            if (_loaded) return;
            using var scope = _scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            _cache = await db.Settings.ToDictionaryAsync(s => s.Key, s => s.Value, StringComparer.Ordinal, ct);
            _loaded = true;
        }
        catch (Exception ex)
        {
            // A config read must never take the app down — an unconfigured
            // instance is a working instance with SSO and mail switched off.
            _logger.LogWarning(ex, "Instance config could not be loaded; treating every setting as unset");
            _cache = new Dictionary<string, string?>(StringComparer.Ordinal);
            _loaded = true;
        }
        finally { _gate.Release(); }
    }

    /// <summary>Force the next read to hit the database again.</summary>
    public void Invalidate() => _loaded = false;

    public string? Get(string key) => _cache.GetValueOrDefault(key);

    public string GetOrEmpty(string key) => _cache.GetValueOrDefault(key) ?? string.Empty;

    public bool GetBool(string key) => string.Equals(Get(key), "true", StringComparison.OrdinalIgnoreCase);

    public int GetInt(string key, int fallback) =>
        int.TryParse(Get(key), out var n) ? n : fallback;

    /// <summary>True when a value is present and non-blank.</summary>
    public bool Has(string key) => !string.IsNullOrWhiteSpace(Get(key));

    /// <summary>
    /// Write a batch of keys and refresh the cache. A null value clears the key.
    /// Keys absent from <paramref name="values"/> are left alone, which is what
    /// lets a form omit a secret it doesn't want to overwrite.
    /// </summary>
    public async Task SetAsync(IReadOnlyDictionary<string, string?> values, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            using var scope = _scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            foreach (var (key, value) in values)
            {
                var row = await db.Settings.FindAsync([key], ct);
                if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
                else row.Value = value;
            }
            await db.SaveChangesAsync(ct);
            _cache = await db.Settings.ToDictionaryAsync(s => s.Key, s => s.Value, StringComparer.Ordinal, ct);
            _loaded = true;
            Version++;
        }
        finally { _gate.Release(); }
    }
}

/// <summary>Setting keys for SSO. See <see cref="InstanceConfigStore"/>.</summary>
public static class OidcKeys
{
    public const string Enabled = "oidc.enabled";
    public const string Authority = "oidc.authority";
    public const string ClientId = "oidc.clientId";
    public const string ClientSecret = "oidc.clientSecret";
    public const string DisplayName = "oidc.displayName";
}

/// <summary>Setting keys for outbound mail. See <see cref="InstanceConfigStore"/>.</summary>
public static class SmtpKeys
{
    public const string Enabled = "smtp.enabled";
    public const string Host = "smtp.host";
    public const string Port = "smtp.port";
    public const string UseSsl = "smtp.useSsl";
    public const string Username = "smtp.username";
    public const string Password = "smtp.password";
    public const string FromAddress = "smtp.fromAddress";
    public const string FromName = "smtp.fromName";
    /// <summary>Absolute base URL used to build links in emails (reset, invite).</summary>
    public const string PublicUrl = "smtp.publicUrl";
}
