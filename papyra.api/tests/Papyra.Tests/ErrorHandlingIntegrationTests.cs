using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace Papyra.Tests;

// The whole pipeline, failing for real: an exception thrown from deep inside a
// request must come out as Papyra's error (reference + trace), in the shape
// the caller asked for — and SSO's failure paths must land back on the sign-in
// page with a reason and a reference, never on a bare 500.
public sealed class ErrorHandlingIntegrationTests
{
    /// <summary>Authentication that blows up on every request — a stand-in for any bug below a navigation.</summary>
    private sealed class ExplodingSchemes(IOptions<AuthenticationOptions> options) : AuthenticationSchemeProvider(options)
    {
        public override Task<IEnumerable<AuthenticationScheme>> GetRequestHandlerSchemesAsync() =>
            throw new InvalidOperationException("disk on fire");
    }

    private static void Explode(IServiceCollection s) => s.AddSingleton<IAuthenticationSchemeProvider, ExplodingSchemes>();

    private sealed class ExplodingConfig(Exception ex) : IConfigurationManager<OpenIdConnectConfiguration>
    {
        public Task<OpenIdConnectConfiguration> GetConfigurationAsync(CancellationToken cancel) => Task.FromException<OpenIdConnectConfiguration>(ex);
        public void RequestRefresh() { }
    }

    private static (WebApplicationFactory<Program>, string) NewApp(Action<IServiceCollection> services, bool errorDetails = true)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-err-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.UseSetting("Papyra:ErrorDetails", errorDetails ? "true" : "false");
            b.ConfigureTestServices(services);
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static HttpRequestMessage Navigate(string path)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, path);
        req.Headers.Add("Accept", "text/html,application/xhtml+xml");
        return req;
    }

    [Fact]
    public async Task ACrashUnderANavigation_RendersPapyrasErrorPage()
    {
        var (factory, dir) = NewApp(Explode);
        try
        {
            var res = await factory.CreateClient().SendAsync(Navigate("/settings"));
            Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
            Assert.StartsWith("text/html", res.Content.Headers.ContentType!.ToString());
            var html = await res.Content.ReadAsStringAsync();
            Assert.Contains("Something went wrong", html);
            Assert.Matches("Reference [A-Z2-9]{4}-[A-Z2-9]{4}", html);
            Assert.Contains("disk on fire", html);
            Assert.Contains("default-src 'none'", res.Headers.GetValues("Content-Security-Policy").Single());
            Assert.Equal("no-store", res.Headers.CacheControl!.ToString());

            // The same failure fetched by script (no text/html) is JSON.
            var json = await factory.CreateClient().GetAsync("/app.js");
            Assert.Equal(HttpStatusCode.InternalServerError, json.StatusCode);
            var body = await json.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("server_error", body.GetProperty("code").GetString());
            Assert.Contains("disk on fire", body.GetProperty("detail").GetProperty("stack").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WithDetailsOff_OnlyTheReferenceIsShown()
    {
        var (factory, dir) = NewApp(Explode, errorDetails: false);
        try
        {
            var html = await (await factory.CreateClient().SendAsync(Navigate("/"))).Content.ReadAsStringAsync();
            Assert.Matches("Reference [A-Z2-9]{4}-[A-Z2-9]{4}", html);
            Assert.DoesNotContain("disk on fire", html);
            Assert.DoesNotContain("Technical details", html);
        }
        finally { Cleanup(factory, dir); }
    }

    private static async Task<HttpClient> AdminWithProviderAsync(WebApplicationFactory<Program> factory)
    {
        var admin = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "admin@example.com", Password: "hunter2!"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/auth/oidc/providers", new SsoProviderWrite(
            "authentik", "Authentik", "https://idp.example.com", "papyra", "s3cret", true))).StatusCode);
        return admin;
    }

    [Fact]
    public async Task AnSsoBug_IsAReferencedServerError_NotABare500()
    {
        // Not a network failure (those have their own answer): a genuine bug.
        var (factory, dir) = NewApp(s => s.PostConfigureAll<OpenIdConnectOptions>(o =>
            o.ConfigurationManager = new ExplodingConfig(new InvalidOperationException("bad metadata"))));
        try
        {
            await AdminWithProviderAsync(factory);
            var res = await factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false })
                .GetAsync("/api/auth/login/sso/authentik");
            Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Matches("^[A-Z2-9]{4}-[A-Z2-9]{4}$", body.GetProperty("errorId").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnUnreachableIdp_SendsTheBrowserBackToSignInWithAReason()
    {
        var (factory, dir) = NewApp(s => s.PostConfigureAll<OpenIdConnectOptions>(o =>
            o.ConfigurationManager = new ExplodingConfig(new InvalidOperationException("IDX20803",
                new IOException("IDX20804", new HttpRequestException("connection refused"))))));
        try
        {
            await AdminWithProviderAsync(factory);
            var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            var clicked = await client.SendAsync(Navigate("/api/auth/login/sso/authentik"));
            Assert.Equal(HttpStatusCode.Redirect, clicked.StatusCode);
            Assert.Matches("^/login\\?sso=unreachable&ref=[A-Z2-9]{4}-[A-Z2-9]{4}$", clicked.Headers.Location!.ToString());

            // A script asking gets the 502 with the same kind of reference.
            var fetched = await client.GetAsync("/api/auth/login/sso/authentik");
            Assert.Equal(HttpStatusCode.BadGateway, fetched.StatusCode);
            Assert.True((await fetched.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("errorId", out _));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ABrokenCallback_ReturnsToSignInWithAReference()
    {
        var (factory, dir) = NewApp(s => s.PostConfigureAll<OpenIdConnectOptions>(o =>
            o.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(new OpenIdConnectConfiguration
            {
                Issuer = "https://idp.example.com",
                AuthorizationEndpoint = "https://idp.example.com/authorize",
                TokenEndpoint = "https://idp.example.com/token",
            })));
        try
        {
            await AdminWithProviderAsync(factory);
            var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            // What an IdP error, a tampered state or a lost correlation cookie looks like on the way back.
            foreach (var callback in new[]
            {
                "/signin-oidc/authentik?error=access_denied&state=x",
                "/signin-oidc/authentik?code=abc&state=tampered",
            })
            {
                var res = await client.SendAsync(Navigate(callback));
                Assert.Equal(HttpStatusCode.Redirect, res.StatusCode);
                Assert.Matches("^/login\\?sso=failed&ref=[A-Z2-9]{4}-[A-Z2-9]{4}$", res.Headers.Location!.ToString());
            }
        }
        finally { Cleanup(factory, dir); }
    }
}
