using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Secrets typed into Settings (SMTP password, SSO client secrets, git tokens) are stored sealed, not
// as plain text, and an install that still has them in plain keeps working and is upgraded on start.
public sealed class SecretSealingTests
{
    private const string Pw = "hunter2!";

    private static SecretBox NewBox(IDataProtectionProvider? provider = null) =>
        new(provider ?? new EphemeralDataProtectionProvider(), NullLogger<SecretBox>.Instance);

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-seal-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var res = await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "admin@example.com", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return client;
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<string?> RawAsync(WebApplicationFactory<Program> factory, string key)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return (await db.Settings.AsNoTracking().FirstOrDefaultAsync(s => s.Key == key))?.Value;
    }

    private static async Task PutRawAsync(WebApplicationFactory<Program> factory, string key, string value)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.Settings.FindAsync(key);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
        await db.SaveChangesAsync();
    }

    // ── SecretBox on its own ────────────────────────────────────────────────────

    [Fact]
    public void ASealedSecret_OpensAgain_AndIsNotReadableAsStored()
    {
        var box = NewBox();
        var stored = box.Seal("smtp-secret");

        Assert.StartsWith(SecretBox.Prefix, stored);
        Assert.DoesNotContain("smtp-secret", stored);
        Assert.Equal("smtp-secret", box.Open(stored));
    }

    [Fact]
    public void BlankAndAlreadySealedValues_PassThroughUnchanged()
    {
        var box = NewBox();
        Assert.Null(box.Seal(null));
        Assert.Equal("", box.Seal(""));

        var once = box.Seal("x");
        Assert.Equal(once, box.Seal(once)); // never sealed twice
    }

    [Fact]
    public void AnOlderPlainValue_IsAcceptedAsItIs()
    {
        Assert.Equal("old-plain-password", NewBox().Open("old-plain-password"));
    }

    [Fact]
    public void ASealedValue_WhoseKeyRingIsGone_ReadsAsNotSet_InsteadOfThrowing()
    {
        var stored = NewBox().Seal("smtp-secret");

        // A different key ring: what a restored database without its keys looks like.
        Assert.Null(NewBox().Open(stored));
    }

    // ── The SMTP password, through the real app ─────────────────────────────────

    [Fact]
    public async Task TheSmtpPassword_IsStoredSealed_AndStillReachesTheMailSender()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var save = await admin.PutAsJsonAsync("/api/auth/smtp", new SmtpConfigWrite(
                Enabled: true, Host: "smtp.example.com", Port: 465, UseSsl: true,
                Username: "papyra", Password: "smtp-secret",
                FromAddress: "papyra@example.com", FromName: "Papyra", PublicUrl: "https://notes.example.com"));
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            var raw = await RawAsync(factory, SmtpKeys.Password);
            Assert.StartsWith(SecretBox.Prefix, raw);
            Assert.DoesNotContain("smtp-secret", raw);

            var store = factory.Services.GetRequiredService<InstanceConfigStore>();
            await store.EnsureLoadedAsync();
            Assert.Equal("smtp-secret", store.Get(SmtpKeys.Password));

            var cfg = await admin.GetFromJsonAsync<JsonElement>("/api/auth/smtp");
            Assert.True(cfg.GetProperty("hasPassword").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SavingTheMailFormWithoutRetypingThePassword_KeepsTheSealedOne()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PutAsJsonAsync("/api/auth/smtp", new SmtpConfigWrite(
                true, "smtp.example.com", 587, false, "papyra", "smtp-secret", "papyra@example.com", "Papyra", null));
            var before = await RawAsync(factory, SmtpKeys.Password);

            var again = await admin.PutAsJsonAsync("/api/auth/smtp", new SmtpConfigWrite(
                true, "smtp2.example.com", 587, false, "papyra", null, "papyra@example.com", "Papyra", null));
            Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);

            Assert.Equal(before, await RawAsync(factory, SmtpKeys.Password));
            var store = factory.Services.GetRequiredService<InstanceConfigStore>();
            Assert.Equal("smtp-secret", store.Get(SmtpKeys.Password));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── An install that still holds plain secrets ───────────────────────────────

    [Fact]
    public async Task APlainSecretFromAnOlderVersion_StillWorks_ThenIsSealedByTheUpgrade()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            var box = factory.Services.GetRequiredService<SecretBox>();
            var store = factory.Services.GetRequiredService<InstanceConfigStore>();

            // What a version before this one left behind.
            await PutRawAsync(factory, SmtpKeys.Password, "old-smtp-password");
            await PutRawAsync(factory, InstanceBackupKeys.GitToken, "old-backup-token");
            await PutRawAsync(factory, GitKeys.Token("7"), "old-user-token");
            await PutRawAsync(factory, SsoProviders.ProvidersKey, JsonSerializer.Serialize(new[]
            {
                new { id = "acme", kind = "other", displayName = "Acme", authority = "https://idp.example.com",
                      clientId = "papyra", clientSecret = "old-sso-secret", enabled = true },
            }));

            // Before the upgrade runs it is read exactly as it was.
            store.Invalidate();
            await store.EnsureLoadedAsync();
            Assert.Equal("old-smtp-password", store.Get(SmtpKeys.Password));
            Assert.Equal("old-sso-secret", Assert.Single(SsoProviders.Read(store)).ClientSecret);

            int sealedCount;
            using (var scope = factory.Services.CreateScope())
                sealedCount = await SecretSettings.SealLegacyAsync(
                    scope.ServiceProvider.GetRequiredService<AppDbContext>(), box, NullLogger.Instance);
            Assert.Equal(4, sealedCount);

            foreach (var (key, secret) in new[]
            {
                (SmtpKeys.Password, "old-smtp-password"),
                (InstanceBackupKeys.GitToken, "old-backup-token"),
                (GitKeys.Token("7"), "old-user-token"),
                (SsoProviders.ProvidersKey, "old-sso-secret"),
            })
            {
                var raw = await RawAsync(factory, key);
                Assert.DoesNotContain(secret, raw);
                Assert.Contains(SecretBox.Prefix, raw);
            }

            // …and reads the same afterwards.
            store.Invalidate();
            await store.EnsureLoadedAsync();
            Assert.Equal("old-smtp-password", store.Get(SmtpKeys.Password));
            Assert.Equal("old-backup-token", store.Get(InstanceBackupKeys.GitToken));
            Assert.Equal("old-sso-secret", Assert.Single(SsoProviders.Read(store)).ClientSecret);
            Assert.Equal("old-user-token", box.Open(await RawAsync(factory, GitKeys.Token("7"))));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheUpgrade_IsRepeatable_AndLeavesBlankSecretsAlone()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            var box = factory.Services.GetRequiredService<SecretBox>();
            await PutRawAsync(factory, SmtpKeys.Password, "plain-once");
            await PutRawAsync(factory, InstanceBackupKeys.GitToken, "");

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal(1, await SecretSettings.SealLegacyAsync(db, box, NullLogger.Instance));
            var sealedOnce = await RawAsync(factory, SmtpKeys.Password);

            Assert.Equal(0, await SecretSettings.SealLegacyAsync(db, box, NullLogger.Instance));
            Assert.Equal(sealedOnce, await RawAsync(factory, SmtpKeys.Password));
            Assert.Equal("", await RawAsync(factory, InstanceBackupKeys.GitToken));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── SSO client secrets ──────────────────────────────────────────────────────

    [Fact]
    public async Task AnSsoClientSecret_IsStoredSealed_AndReadsBackPlain()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            var store = factory.Services.GetRequiredService<InstanceConfigStore>();
            await SsoProviders.WriteAsync(store, [new SsoProvider
            {
                Id = "acme", Kind = "other", DisplayName = "Acme", Authority = "https://idp.example.com",
                ClientId = "papyra", ClientSecret = "sso-secret", Enabled = true,
            }], default);

            var raw = await RawAsync(factory, SsoProviders.ProvidersKey);
            Assert.DoesNotContain("sso-secret", raw);
            Assert.Contains(SecretBox.Prefix, raw);

            Assert.Equal("sso-secret", Assert.Single(SsoProviders.Read(store)).ClientSecret);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── A git token, through the real endpoint ──────────────────────────────────

    [Fact]
    public async Task AGitToken_IsStoredSealed_AndUsableAfterwards()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var uid = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();

            var save = await admin.PutAsJsonAsync("/api/git", new GitConfigWrite(
                RemoteUrl: "https://example.com/me/notes.git", Branch: "main", Token: "ghp_secret_token"));
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            var raw = await RawAsync(factory, GitKeys.Token(uid.ToString()));
            Assert.DoesNotContain("ghp_secret_token", raw);
            Assert.StartsWith(SecretBox.Prefix, raw);

            var git = factory.Services.GetRequiredService<GitSyncService>();
            Assert.Equal("ghp_secret_token", git.OpenToken(raw));

            var cfg = await admin.GetFromJsonAsync<JsonElement>("/api/git");
            Assert.True(cfg.GetProperty("hasToken").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }
}
