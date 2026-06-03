using Microsoft.Extensions.Configuration;
using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Tests.Email;

// ── GlobalSettingsSmtpTests ───────────────────────────────────────────────────
// Verifies that SmtpSettings round-trips through GlobalSettingsService correctly
// and that AdminEndpoints.RedactSettings never leaks the encrypted password.

public sealed class GlobalSettingsSmtpTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
    private readonly GlobalSettingsService _svc;

    public GlobalSettingsSmtpTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, ".system"));
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:StorageRoot"] = _root,
            })
            .Build();
        _svc = new GlobalSettingsService(config);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public async Task SmtpSettings_RoundTrip_Persists()
    {
        await _svc.UpdateAsync(s =>
        {
            s.Smtp = new SmtpSettings
            {
                Host        = "smtp.example.com",
                Port        = 465,
                Security    = "ssl",
                Username    = "user@example.com",
                PasswordEnc = "enc:abc:def:ghi",
                FromAddress = "papyra@example.com",
                FromName    = "Papyra Test",
            };
        });

        var loaded = await _svc.GetAsync();

        Assert.NotNull(loaded.Smtp);
        Assert.Equal("smtp.example.com", loaded.Smtp.Host);
        Assert.Equal(465,                loaded.Smtp.Port);
        Assert.Equal("ssl",              loaded.Smtp.Security);
        Assert.Equal("user@example.com", loaded.Smtp.Username);
        Assert.Equal("enc:abc:def:ghi",  loaded.Smtp.PasswordEnc);
        Assert.Equal("papyra@example.com", loaded.Smtp.FromAddress);
        Assert.Equal("Papyra Test",      loaded.Smtp.FromName);
    }

    [Fact]
    public async Task RedactSettings_HidesPasswordEnc()
    {
        await _svc.UpdateAsync(s =>
        {
            s.Smtp = new SmtpSettings
            {
                Host        = "smtp.example.com",
                Port        = 587,
                PasswordEnc = "enc:secret:goes:here",
                FromAddress = "from@example.com",
            };
        });

        var raw     = await _svc.GetAsync();
        var redacted = Papyra.Api.Endpoints.AdminEndpoints.RedactSettings(raw);

        // Serialise to JSON and verify no raw password appears
        var json = System.Text.Json.JsonSerializer.Serialize(redacted);
        Assert.DoesNotContain("secret", json);
        Assert.Contains("\"hasPassword\":true", json);
    }

    [Fact]
    public async Task RedactSettings_HasPasswordFalse_WhenNoPassword()
    {
        await _svc.UpdateAsync(s =>
        {
            s.Smtp = new SmtpSettings
            {
                Host        = "smtp.example.com",
                Port        = 587,
                PasswordEnc = null,
                FromAddress = "from@example.com",
            };
        });

        var raw      = await _svc.GetAsync();
        var redacted = Papyra.Api.Endpoints.AdminEndpoints.RedactSettings(raw);
        var json     = System.Text.Json.JsonSerializer.Serialize(redacted);

        Assert.Contains("\"hasPassword\":false", json);
    }

    [Fact]
    public async Task RequireEmailVerification_RoundTrips()
    {
        await _svc.UpdateAsync(s => s.RequireEmailVerification = true);
        var loaded = await _svc.GetAsync();
        Assert.True(loaded.RequireEmailVerification);
    }

    [Fact]
    public async Task AllowSelfRegistration_DefaultFalse()
    {
        var loaded = await _svc.GetAsync();
        Assert.False(loaded.AllowSelfRegistration);
    }
}
