using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// An account an admin created or reset has a password its owner never chose,
/// which means somebody else knows it. These tests cover the flag that makes
/// that state temporary: what it blocks, what it still allows, and every route
/// that clears it.
/// </summary>
public sealed class ForcedPasswordChangeTests
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

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    private static async Task<JsonElement> ProvisionAsync(HttpClient admin, string username, string? password)
    {
        var res = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@example.com",
            Password: password, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task AProvisionedAccountMustChangeItsPasswordBeforeDoingAnythingElse()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var created = await ProvisionAsync(admin, "bea", Pw);
            Assert.True(created.GetProperty("mustChangePassword").GetBoolean());

            var bea = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK,
                (await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw))).StatusCode);

            // Blocked, and the code says why so the SPA can route rather than guess.
            var notes = await bea.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Forbidden, notes.StatusCode);
            var body = await notes.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("password_change_required", body.GetProperty("code").GetString());

            // Still allowed: see who you are, and sign out.
            var me = await bea.GetAsync("/api/auth/me");
            Assert.Equal(HttpStatusCode.OK, me.StatusCode);
            Assert.True((await me.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("mustChangePassword").GetBoolean());
            Assert.Equal(HttpStatusCode.NoContent, (await bea.PostAsync("/api/auth/logout", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ChoosingAPasswordClearsTheFlagAndRestoresTheAccount()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await ProvisionAsync(admin, "bea", Pw);

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));

            var change = await bea.PostAsJsonAsync("/api/auth/password",
                new PasswordRequest(Current: Pw, Next: "her own one"));
            Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);

            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/notes")).StatusCode);
            var me = await bea.GetAsync("/api/auth/me");
            Assert.False((await me.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("mustChangePassword").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheFlagBitesASessionThatIsAlreadyOpen()
    {
        // The reason the middleware reads the database instead of a cookie claim:
        // an admin resetting a compromised account has to end that account's
        // access now, not at its next sign-in.
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var created = await ProvisionAsync(admin, "bea", Pw);
            var beaId = created.GetProperty("id").GetInt32();

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/notes")).StatusCode);

            var reset = await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/reset", new ResetRequest(Password: null));
            Assert.Equal(HttpStatusCode.OK, reset.StatusCode);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/notes")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ProvisioningWithoutAPasswordGeneratesOneAndReturnsItOnce()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var created = await ProvisionAsync(admin, "bea", password: null);

            var generated = created.GetProperty("password").GetString()!;
            Assert.Equal(19, generated.Length);          // 16 characters in 4 groups
            Assert.Equal(3, generated.Count(c => c == '-'));
            Assert.False(created.GetProperty("emailed").GetBoolean()); // no SMTP in tests

            // It is a real password, not a placeholder.
            var bea = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK,
                (await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", generated))).StatusCode);

            // And nothing can read it back — the roster carries the flag, not the password.
            var roster = await (await admin.GetAsync("/api/auth/users")).Content.ReadFromJsonAsync<JsonElement>();
            var row = roster.EnumerateArray().Single(u => u.GetProperty("username").GetString() == "bea");
            Assert.True(row.GetProperty("mustChangePassword").GetBoolean());
            Assert.False(row.TryGetProperty("password", out _));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TwoGeneratedPasswordsAreNotTheSame()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var first = (await ProvisionAsync(admin, "bea", null)).GetProperty("password").GetString();
            var second = (await ProvisionAsync(admin, "cleo", null)).GetProperty("password").GetString();
            Assert.NotEqual(first, second);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AResetHandsBackAPasswordAndForcesAChange()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var beaId = (await ProvisionAsync(admin, "bea", Pw)).GetProperty("id").GetInt32();

            var res = await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/reset", new ResetRequest(Password: null));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var temporary = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("password").GetString()!;

            var bea = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw))).StatusCode);
            Assert.Equal(HttpStatusCode.OK,
                (await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", temporary))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/notes")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ARecoveryLinkResetsTheAccountAndClearsTheFlag()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var beaId = (await ProvisionAsync(admin, "bea", Pw)).GetProperty("id").GetInt32();

            var res = await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/recovery-link", new RecoveryLinkRequest());
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var link = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("link").GetString()!;
            var token = link[(link.IndexOf("token=", StringComparison.Ordinal) + 6)..];

            var anonymous = factory.CreateClient();
            var probe = await anonymous.GetAsync($"/api/auth/token/{token}");
            Assert.Equal(HttpStatusCode.OK, probe.StatusCode);
            Assert.Equal("reset", (await probe.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("kind").GetString());

            var reset = await anonymous.PostAsJsonAsync("/api/auth/reset-password",
                new ResetPasswordRequest(Token: token, Password: "chosen by bea"));
            Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

            // Setting a password through the link is the owner choosing one, so the
            // account comes back to life without a second trip through the form.
            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", "chosen by bea"));
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/notes")).StatusCode);

            // Single use.
            var again = await anonymous.PostAsJsonAsync("/api/auth/reset-password",
                new ResetPasswordRequest(Token: token, Password: "another one"));
            Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OnlyAnAdminCanProvisionResetOrRecover()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var beaId = (await ProvisionAsync(admin, "bea", Pw)).GetProperty("id").GetInt32();

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsJsonAsync("/api/auth/users",
                new ProvisionRequest("mallory", null, null, Pw, "Admin"))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsJsonAsync(
                $"/api/auth/users/{beaId}/reset", new ResetRequest(Password: null))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsJsonAsync(
                $"/api/auth/users/{beaId}/recovery-link", new RecoveryLinkRequest())).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SendingCredentialsNeedsAnAddressToSendThemTo()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "", Password: null, Role: "User", SendEmail: true));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheFirstAdminIsNotForcedToChangeAnything()
    {
        // Setup is someone choosing their own password, so the flag would be a
        // pointless hoop on the very first screen.
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var me = await admin.GetAsync("/api/auth/me");
            Assert.False((await me.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("mustChangePassword").GetBoolean());
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/notes")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
