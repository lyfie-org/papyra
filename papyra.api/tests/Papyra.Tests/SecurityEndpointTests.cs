using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Security;

namespace Papyra.Tests;

// The hardening as a caller experiences it: headers on real responses, a login
// that stops answering after enough wrong guesses, and a weak password refused at
// every door that sets one.
public sealed class SecurityEndpointTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-sec-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });

        return (factory, dir);
    }

    private static async Task<HttpClient> SeedAdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return client;
    }

    // ── headers ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task EveryResponseCarriesTheHardeningHeaders()
    {
        var (factory, dir) = NewApp();
        try
        {
            var res = await factory.CreateClient().GetAsync("/health");

            Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("DENY", res.Headers.GetValues("X-Frame-Options").Single());
            Assert.Equal("no-referrer", res.Headers.GetValues("Referrer-Policy").Single());
            Assert.Equal("same-origin", res.Headers.GetValues("Cross-Origin-Opener-Policy").Single());
            Assert.Contains("camera=()", res.Headers.GetValues("Permissions-Policy").Single());

            var csp = res.Headers.GetValues("Content-Security-Policy").Single();
            Assert.Contains("frame-ancestors 'none'", csp);
            Assert.Contains("object-src 'none'", csp);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task HstsIsWithheldOverPlainHttp()
    {
        var (factory, dir) = NewApp();
        try
        {
            // Pinning an http origin to HTTPS for a year would be unrecoverable
            // for a self-hoster still setting up TLS.
            var res = await factory.CreateClient().GetAsync("/health");
            Assert.False(res.Headers.Contains("Strict-Transport-Security"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheDocsPortalGetsItsOwnLooserPolicy()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,
            });

            var app = await client.GetAsync("/health");
            var docs = await client.GetAsync("/docs/");

            var appCsp = app.Headers.GetValues("Content-Security-Policy").Single();
            var docsCsp = docs.Headers.GetValues("Content-Security-Policy").Single();

            Assert.NotEqual(appCsp, docsCsp);
            Assert.Contains("script-src 'self' 'unsafe-inline'", docsCsp);
            Assert.DoesNotContain("script-src 'self' 'unsafe-inline'", appCsp);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── login throttling ─────────────────────────────────────────────────────

    [Fact]
    public async Task LoginStopsAnsweringAfterEnoughWrongGuesses()
    {
        var (factory, dir) = NewApp();
        try
        {
            await SeedAdminAsync(factory);
            var client = factory.CreateClient();

            for (var i = 0; i < LoginThrottle.MaxFailures; i++)
            {
                var attempt = await client.PostAsJsonAsync("/api/auth/login",
                    new LoginRequest("admin", "wrong-password"));
                Assert.Equal(HttpStatusCode.Unauthorized, attempt.StatusCode);
            }

            // Even the *correct* password is refused now — otherwise the lockout
            // would be trivially confirmable as a password oracle.
            var correct = await client.PostAsJsonAsync("/api/auth/login",
                new LoginRequest("admin", Pw));
            Assert.Equal(HttpStatusCode.TooManyRequests, correct.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OneAccountsLockoutDoesNotLockAnother()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await SeedAdminAsync(factory);
            var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

            var attacker = factory.CreateClient();
            for (var i = 0; i < LoginThrottle.MaxFailures; i++)
                await attacker.PostAsJsonAsync("/api/auth/login", new LoginRequest("admin", "nope"));

            var bea = await factory.CreateClient()
                .PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            Assert.Equal(HttpStatusCode.OK, bea.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AGoodLoginClearsTheFailuresBeforeIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            await SeedAdminAsync(factory);
            var client = factory.CreateClient();

            for (var i = 0; i < LoginThrottle.MaxFailures - 1; i++)
                await client.PostAsJsonAsync("/api/auth/login", new LoginRequest("admin", "nope"));

            var good = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest("admin", Pw));
            Assert.Equal(HttpStatusCode.OK, good.StatusCode);

            // Budget restored: a fresh run of failures is needed to lock again.
            for (var i = 0; i < LoginThrottle.MaxFailures - 1; i++)
            {
                var again = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest("admin", "nope"));
                Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
            }
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnUnknownUsernameAnswersExactlyLikeAWrongPassword()
    {
        var (factory, dir) = NewApp();
        try
        {
            await SeedAdminAsync(factory);
            var client = factory.CreateClient();

            var wrongPassword = await client.PostAsJsonAsync("/api/auth/login",
                new LoginRequest("admin", "definitely-not-it"));
            var noSuchUser = await client.PostAsJsonAsync("/api/auth/login",
                new LoginRequest("ghost", "definitely-not-it"));

            Assert.Equal(wrongPassword.StatusCode, noSuchUser.StatusCode);
            Assert.Equal(
                await wrongPassword.Content.ReadAsStringAsync(),
                await noSuchUser.Content.ReadAsStringAsync());
        }
        finally { Cleanup(factory, dir); }
    }

    // ── password policy at every door ────────────────────────────────────────

    [Fact]
    public async Task SetupRefusesAWeakFirstAdminPassword()
    {
        var (factory, dir) = NewApp();
        try
        {
            var res = await factory.CreateClient().PostAsJsonAsync("/api/auth/setup",
                new SetupRequest(Username: "admin", Name: "A", Email: "a@b.c", Password: "short"));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ProvisioningAndResetAndSelfChangeAllRefuseAWeakPassword()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await SeedAdminAsync(factory);

            var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: "weak", Role: "User"));
            Assert.Equal(HttpStatusCode.BadRequest, provision.StatusCode);

            var ok = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));
            var beaId = (await ok.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>())
                .GetProperty("id").GetInt32();

            var reset = await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/reset",
                new ResetRequest(Password: "weak"));
            Assert.Equal(HttpStatusCode.BadRequest, reset.StatusCode);

            var selfChange = await admin.PostAsJsonAsync("/api/auth/password",
                new PasswordRequest(Current: Pw, Next: "weak"));
            Assert.Equal(HttpStatusCode.BadRequest, selfChange.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }
}
