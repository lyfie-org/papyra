using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Git backup belongs to the account that owns the notes.
//
// It used to be one instance-wide admin setting whose repository was the entire
// users directory — so an admin configuring a backup silently published every
// tenant's notes to their remote, and no other user could set up their own. These
// tests pin the replacement: settings are per account, invisible across accounts,
// and reachable without being an admin.
public sealed class GitSyncScopeTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-git-" + Guid.NewGuid().ToString("N"));
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
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "admin@example.com", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(WebApplicationFactory<Program> factory, HttpClient admin, string username)
    {
        var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@example.com", Password: Pw, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

        var client = factory.CreateClient();
        var login = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, Pw));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        return client;
    }

    [Fact]
    public async Task AnOrdinaryUser_CanConfigureTheirOwnBackup()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var bea = await MemberAsync(factory, admin, "bea");

            // The old route was admin-only, so a normal account could not back up
            // its own notes at all.
            var save = await bea.PutAsJsonAsync("/api/git", new
            {
                remoteUrl = "https://example.com/bea/notes.git",
                branch = "main",
                token = "bea-secret-token",
            });
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            var raw = await (await bea.GetAsync("/api/git")).Content.ReadAsStringAsync();
            Assert.DoesNotContain("bea-secret-token", raw); // write-only, like every other secret

            var cfg = JsonDocument.Parse(raw).RootElement;
            Assert.Equal("https://example.com/bea/notes.git", cfg.GetProperty("remoteUrl").GetString());
            Assert.True(cfg.GetProperty("hasToken").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OneUsersBackupSettings_AreInvisibleToEveryoneElse()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var bea = await MemberAsync(factory, admin, "bea");
            var cal = await MemberAsync(factory, admin, "cal");

            await bea.PutAsJsonAsync("/api/git", new
            {
                remoteUrl = "https://example.com/bea/notes.git",
                branch = "main",
                token = "bea-secret-token",
            });

            // Neither a peer nor the admin sees Bea's remote — an admin has no
            // route through Papyra to another account's vault or its backup.
            foreach (var other in new[] { cal, admin })
            {
                var cfg = await (await other.GetAsync("/api/git")).Content.ReadFromJsonAsync<JsonElement>();
                Assert.Equal(string.Empty, cfg.GetProperty("remoteUrl").GetString());
                Assert.False(cfg.GetProperty("hasToken").GetBoolean());
            }
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SavingABackup_DoesNotDisturbAnotherAccountsSettings()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var bea = await MemberAsync(factory, admin, "bea");

            await bea.PutAsJsonAsync("/api/git", new { remoteUrl = "https://example.com/bea.git", branch = "main", token = "t1" });
            await admin.PutAsJsonAsync("/api/git", new { remoteUrl = "https://example.com/admin.git", branch = "trunk", token = "t2" });

            var beaCfg = await (await bea.GetAsync("/api/git")).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("https://example.com/bea.git", beaCfg.GetProperty("remoteUrl").GetString());
            Assert.Equal("main", beaCfg.GetProperty("branch").GetString());

            var adminCfg = await (await admin.GetAsync("/api/git")).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("https://example.com/admin.git", adminCfg.GetProperty("remoteUrl").GetString());
            Assert.Equal("trunk", adminCfg.GetProperty("branch").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AMalformedRemote_IsRefused()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PutAsJsonAsync("/api/git", new { remoteUrl = "github.com/me/notes", branch = "main" });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SyncingWithNoRemote_IsIdleRatherThanAnError()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var bea = await MemberAsync(factory, admin, "bea");

            var res = await bea.PostAsync("/api/git/sync", null);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);

            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("disabled", body.GetProperty("status").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public void SettingsKeys_AreNamespacedPerAccount()
    {
        // The namespacing is what keeps one account's remote out of another's
        // read, so pin the shape rather than trusting the callers.
        Assert.StartsWith("git.u7.", GitKeys.Prefix("7"));
        Assert.Equal("git.u7.remoteUrl", GitKeys.RemoteUrl("7"));
        Assert.NotEqual(GitKeys.Token("7"), GitKeys.Token("8"));

        // Legacy keys must not collide with a namespaced one, or the boot
        // migration would delete a live per-user setting.
        Assert.DoesNotContain(GitKeys.LegacyKeys, k => k.StartsWith("git.u", StringComparison.Ordinal));
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }
}
