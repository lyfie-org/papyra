using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// Admin-configurable instance settings: SSO and outbound mail.
//
// The headline case is the boring one — an instance with neither configured must
// behave completely normally. Registering the OIDC scheme unconditionally (so it
// can be switched on later without a restart) means its options are validated on
// ordinary requests, and OpenIdConnectOptions.Validate() throws on an empty
// ClientId. That turned *every* endpoint into a 500 until placeholders were
// supplied, so the first test here is a guard against reintroducing it.
public sealed class InstanceConfigEndpointTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-cfg-" + Guid.NewGuid().ToString("N"));
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

    [Fact]
    public async Task AnInstanceWithNoSsoConfigured_ServesOrdinaryRequests()
    {
        var (factory, dir) = NewApp();
        try
        {
            // /health is about as far from SSO as an endpoint gets — which is the
            // point: the regression made it 500 too.
            var health = await factory.CreateClient().GetAsync("/health");
            Assert.Equal(HttpStatusCode.OK, health.StatusCode);

            var providers = await factory.CreateClient().GetAsync("/api/auth/providers");
            Assert.Equal(HttpStatusCode.OK, providers.StatusCode);
            var body = await providers.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(body.GetProperty("sso").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SsoLogin_IsRefusedUntilItIsConfigured()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,  // a challenge would 302 to the IdP
            });
            var res = await client.GetAsync("/api/auth/login/sso");
            Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task EnablingSso_RequiresAuthorityAndClientId()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PutAsJsonAsync("/api/auth/oidc", new OidcConfigWrite(
                Enabled: true, Authority: "", ClientId: "", ClientSecret: null, DisplayName: null));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SsoAuthority_MustBeHttps()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            // Tokens and the client secret cross this connection.
            var res = await admin.PutAsJsonAsync("/api/auth/oidc", new OidcConfigWrite(
                Enabled: true, Authority: "http://idp.example.com", ClientId: "papyra",
                ClientSecret: "s3cret", DisplayName: "Acme"));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ConfiguringSso_TakesEffectWithoutARestart_AndNeverEchoesTheSecret()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var save = await admin.PutAsJsonAsync("/api/auth/oidc", new OidcConfigWrite(
                Enabled: true, Authority: "https://idp.example.com", ClientId: "papyra",
                ClientSecret: "s3cret", DisplayName: "Acme SSO"));
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            // Same process, no restart: the login screen now offers SSO.
            var providers = await factory.CreateClient().GetAsync("/api/auth/providers");
            var body = await providers.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(body.GetProperty("sso").GetBoolean());
            Assert.Equal("Acme SSO", body.GetProperty("ssoName").GetString());

            // The secret is reported as present, never returned.
            var read = await admin.GetAsync("/api/auth/oidc");
            var raw = await read.Content.ReadAsStringAsync();
            Assert.DoesNotContain("s3cret", raw);
            var cfg = JsonDocument.Parse(raw).RootElement;
            Assert.True(cfg.GetProperty("hasClientSecret").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SsoConfig_IsAdminOnly()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@example.com", Password: Pw, Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/auth/oidc")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/auth/smtp")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Outbound mail ────────────────────────────────────────────────────────

    [Fact]
    public async Task EnablingEmail_RequiresHostAndFromAddress()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PutAsJsonAsync("/api/auth/smtp", new SmtpConfigWrite(
                Enabled: true, Host: "", Port: 587, UseSsl: true, Username: null, Password: null,
                FromAddress: "", FromName: null, PublicUrl: null));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task EmailConfig_RoundTripsWithoutEchoingThePassword()
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

            var raw = await (await admin.GetAsync("/api/auth/smtp")).Content.ReadAsStringAsync();
            Assert.DoesNotContain("smtp-secret", raw);
            var cfg = JsonDocument.Parse(raw).RootElement;
            Assert.True(cfg.GetProperty("hasPassword").GetBoolean());
            Assert.Equal(465, cfg.GetProperty("port").GetInt32());
            Assert.Equal("smtp.example.com", cfg.GetProperty("host").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ForgotPassword_AnswersIdenticallyForKnownAndUnknownAccounts()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            var anon = factory.CreateClient();

            var known = await anon.PostAsJsonAsync("/api/auth/forgot-password",
                new ForgotPasswordRequest("admin"));
            var unknown = await anon.PostAsJsonAsync("/api/auth/forgot-password",
                new ForgotPasswordRequest("nobody-here"));

            // Byte-identical: this endpoint must not be a membership oracle.
            Assert.Equal(known.StatusCode, unknown.StatusCode);
            Assert.Equal(
                await known.Content.ReadAsStringAsync(),
                await unknown.Content.ReadAsStringAsync());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnInvalidResetToken_IsRefused()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            var anon = factory.CreateClient();

            Assert.Equal(HttpStatusCode.NotFound,
                (await anon.GetAsync("/api/auth/token/made-up-token")).StatusCode);

            var reset = await anon.PostAsJsonAsync("/api/auth/reset-password",
                new ResetPasswordRequest("made-up-token", "brand-new-password"));
            Assert.Equal(HttpStatusCode.BadRequest, reset.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ResetPassword_StillEnforcesThePasswordPolicy()
    {
        var (factory, dir) = NewApp();
        try
        {
            await AdminAsync(factory);
            // Rejected on the password, before the token is even looked at — a
            // valid link must not become a way around the length floor.
            var res = await factory.CreateClient().PostAsJsonAsync("/api/auth/reset-password",
                new ResetPasswordRequest("whatever", "short"));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NotificationPreferences_DefaultToOn_AndRoundTrip()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var initial = await (await admin.GetAsync("/api/auth/notifications"))
                .Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(initial.GetProperty("mention").GetBoolean());
            Assert.True(initial.GetProperty("share").GetBoolean());
            // No SMTP configured in this instance, and the UI needs to say so.
            Assert.False(initial.GetProperty("emailConfigured").GetBoolean());

            var save = await admin.PutAsJsonAsync("/api/auth/notifications",
                new NotificationPrefsWrite(Mention: false, Share: null));
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            var after = await (await admin.GetAsync("/api/auth/notifications"))
                .Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(after.GetProperty("mention").GetBoolean());
            // Omitted fields are left alone rather than reset to a default.
            Assert.True(after.GetProperty("share").GetBoolean());
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
