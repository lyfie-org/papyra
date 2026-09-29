using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// What an administrator can do to an account after it exists — change its role,
/// switch it off and on — and the promise behind each: it takes effect on the
/// sessions and keys already out there, not at some later sign-in.
/// </summary>
public sealed class AccountStandingTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var setup = await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    /// <summary>A second account, signed in and past its forced password change.</summary>
    private static async Task<(int Id, HttpClient Client)> UserAsync(
        WebApplicationFactory<Program> factory, HttpClient admin, string username, string role = "User")
    {
        var res = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@example.com", Password: Pw, Role: role));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var id = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return (id, client);
    }

    private static async Task<int> MyIdAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();

    [Fact]
    public async Task PromotionAndDemotionTakeEffectOnTheOpenSession()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var (beaId, bea) = await UserAsync(factory, admin, "bea");

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/auth/users")).StatusCode);

            var promote = await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/role", new { role = "Admin" });
            Assert.Equal(HttpStatusCode.OK, promote.StatusCode);
            // Same cookie, no sign-in in between: the role is read fresh.
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/auth/users")).StatusCode);

            var demote = await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/role", new { role = "User" });
            Assert.Equal(HttpStatusCode.OK, demote.StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/auth/users")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NobodyChangesTheirOwnRole_AndOnlyKnownRolesAreAccepted()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var adminId = await MyIdAsync(admin);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await admin.PutAsJsonAsync($"/api/auth/users/{adminId}/role", new { role = "User" })).StatusCode);

            var (beaId, bea) = await UserAsync(factory, admin, "bea", role: "Admin");
            Assert.Equal(HttpStatusCode.BadRequest,
                (await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/role", new { role = "Owner" })).StatusCode);

            // With a second admin around, one can hand the other back to a regular account.
            Assert.Equal(HttpStatusCode.OK,
                (await bea.PutAsJsonAsync($"/api/auth/users/{adminId}/role", new { role = "User" })).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await admin.GetAsync("/api/auth/users")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ADisabledAccountIsSignedOutEverywhereAndCannotGetBackIn()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var (beaId, bea) = await UserAsync(factory, admin, "bea");

            // An API key minted before the lock-out.
            var keyRes = await bea.PostAsJsonAsync("/api/keys", new { name = "script", code = await TestAuth.CodeAsync(bea) });
            Assert.Equal(HttpStatusCode.OK, keyRes.StatusCode);
            var token = (await keyRes.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;

            Assert.Equal(HttpStatusCode.NoContent,
                (await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/disable", new { reason = "Leaked password" })).StatusCode);

            // The open session ends on its next request, with a reason the app can show.
            var me = await bea.GetAsync("/api/auth/me");
            Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
            Assert.Equal("account_disabled", (await me.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Equal(HttpStatusCode.Unauthorized, (await bea.GetAsync("/api/notes")).StatusCode);

            // So does the key.
            var script = factory.CreateClient();
            script.DefaultRequestHeaders.Add("X-API-Key", token);
            Assert.Equal(HttpStatusCode.Unauthorized, (await script.GetAsync("/api/notes")).StatusCode);

            // And the right password no longer signs in.
            var fresh = factory.CreateClient();
            var login = await fresh.LoginAsync("bea", Pw);
            Assert.Equal(HttpStatusCode.Forbidden, login.StatusCode);
            Assert.Equal("account_disabled", (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

            // A wrong password still gets the generic answer: "disabled" is not a free oracle.
            var wrong = await fresh.LoginAsync("bea", "not-it-at-all");
            Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);

            // Admins see it, with the reason.
            var roster = await admin.GetFromJsonAsync<JsonElement>("/api/auth/users");
            var row = roster.EnumerateArray().Single(u => u.GetProperty("id").GetInt32() == beaId);
            Assert.True(row.GetProperty("disabled").GetBoolean());
            Assert.Equal("Leaked password", row.GetProperty("disabledReason").GetString());

            // Turned back on: the password works again.
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/auth/users/{beaId}/enable", null)).StatusCode);
            Assert.Equal(HttpStatusCode.OK,
                (await factory.CreateClient().LoginAsync("bea", Pw)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnAdminCannotDisableThemselves()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PostAsJsonAsync($"/api/auth/users/{await MyIdAsync(admin)}/disable", new { reason = (string?)null });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NotificationSettingsListTheCatalog_AndCriticalOnesCannotBeSwitchedOff()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var (_, bea) = await UserAsync(factory, admin, "bea");

            var prefs = await bea.GetFromJsonAsync<JsonElement>("/api/auth/notifications");
            var events = prefs.GetProperty("events").EnumerateArray().ToList();
            Assert.Contains(events, e => e.GetProperty("id").GetString() == NotificationCatalog.NewSignIn
                && e.GetProperty("critical").GetBoolean() && e.GetProperty("email").GetBoolean());
            // Admin-only notifications aren't offered to a regular account.
            Assert.DoesNotContain(events, e => e.GetProperty("group").GetString() == "admin");
            Assert.Contains("email", prefs.GetProperty("channels").EnumerateArray().Select(c => c.GetString()));

            var off = await bea.PutAsJsonAsync("/api/auth/notifications",
                new { events = new[] { new { id = NotificationCatalog.Mention, enabled = false } } });
            Assert.Equal(HttpStatusCode.NoContent, off.StatusCode);
            prefs = await bea.GetFromJsonAsync<JsonElement>("/api/auth/notifications");
            Assert.False(prefs.GetProperty("mention").GetBoolean());

            var critical = await bea.PutAsJsonAsync("/api/auth/notifications",
                new { events = new[] { new { id = NotificationCatalog.PasswordChanged, enabled = false } } });
            Assert.Equal(HttpStatusCode.BadRequest, critical.StatusCode);

            var adminPrefs = await admin.GetFromJsonAsync<JsonElement>("/api/auth/notifications");
            Assert.Contains(adminPrefs.GetProperty("events").EnumerateArray(),
                e => e.GetProperty("id").GetString() == NotificationCatalog.AdminJobFailed);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public void PreferencesFallBackToTheirDefaults_AndLegacySwitchesStillCount()
    {
        var user = new User { Role = "User", NotifyOnMention = false };
        Assert.False(NotificationPrefs.Wants(user, NotificationCatalog.Mention));
        Assert.True(NotificationPrefs.Wants(user, NotificationCatalog.BackupFailed));
        Assert.False(NotificationPrefs.Wants(user, NotificationCatalog.BackupSucceeded)); // off by default
        Assert.True(NotificationPrefs.Wants(user, NotificationCatalog.PasswordChanged));
        Assert.False(NotificationPrefs.Wants(user, NotificationCatalog.AdminJobFailed));
        Assert.False(NotificationPrefs.Wants(user, "no.such.event"));

        Assert.True(NotificationPrefs.Set(user, NotificationCatalog.BackupSucceeded, true));
        Assert.True(NotificationPrefs.Wants(user, NotificationCatalog.BackupSucceeded));
        Assert.False(NotificationPrefs.Set(user, NotificationCatalog.NewSignIn, false));

        user.NotificationPrefs = "{not json";
        Assert.True(NotificationPrefs.Wants(user, NotificationCatalog.BackupFailed));
    }

    [Fact]
    public async Task SigningInRemembersTheBrowser()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await UserAsync(factory, admin, "bea");

            var browser = factory.CreateClient();
            var first = await browser.LoginAsync("bea", Pw);
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            Assert.Contains(first.Headers.GetValues("Set-Cookie"), c => c.StartsWith("papyra.device=", StringComparison.Ordinal));

            var roster = await admin.GetFromJsonAsync<JsonElement>("/api/auth/users");
            var row = roster.EnumerateArray().Single(u => u.GetProperty("username").GetString() == "bea");
            Assert.NotEqual(JsonValueKind.Null, row.GetProperty("lastSignInUtc").ValueKind);
        }
        finally { Cleanup(factory, dir); }
    }
}
