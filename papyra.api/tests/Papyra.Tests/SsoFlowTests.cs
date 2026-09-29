using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Web;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace Papyra.Tests;

// SSO all the way round, against a fake identity provider: click → IdP →
// callback → token redemption → account match → session. Existing accounts
// only; a stranger gets a clear refusal, a disabled account says so, and once
// linked the IdP's subject — not its email — decides who you are.
public sealed class SsoFlowTests
{
    private const string Issuer = "https://idp.example.com";
    private const string ClientId = "papyra";

    /// <summary>The IdP's token endpoint: hands back an id_token for whoever the test says signed in.</summary>
    private sealed class FakeIdp : HttpMessageHandler
    {
        public readonly RsaSecurityKey Key = new(RSA.Create(2048)) { KeyId = "k1" };
        public (string Sub, string Email) Next = ("sub-1", "admin@example.com");
        public string Nonce = "";

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var token = new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
            {
                Issuer = Issuer,
                Audience = ClientId,
                Claims = new Dictionary<string, object> { ["sub"] = Next.Sub, ["email"] = Next.Email, ["nonce"] = Nonce },
                IssuedAt = DateTime.UtcNow,
                Expires = DateTime.UtcNow.AddMinutes(5),
                SigningCredentials = new SigningCredentials(Key, SecurityAlgorithms.RsaSha256),
            });
            var json = JsonSerializer.Serialize(new { id_token = token, access_token = "at", token_type = "Bearer", expires_in = 300 });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }

    private static (WebApplicationFactory<Program>, string, FakeIdp) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-sso-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var idp = new FakeIdp();
        var config = new OpenIdConnectConfiguration
        {
            Issuer = Issuer,
            AuthorizationEndpoint = $"{Issuer}/authorize",
            TokenEndpoint = $"{Issuer}/token",
        };
        config.SigningKeys.Add(idp.Key);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.ConfigureTestServices(s => s.PostConfigureAll<OpenIdConnectOptions>(o =>
            {
                o.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(config);
                o.Backchannel = new HttpClient(idp);
            }));
        });
        return (factory, dir, idp);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var admin = factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost") });
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "admin@example.com", Password: "hunter2!"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/auth/oidc/providers", new SsoProviderWrite(
            "authentik", "Authentik", Issuer, ClientId, "s3cret", true))).StatusCode);
        return admin;
    }

    /// <summary>A browser signing in: click, "log in at the IdP", come back. Returns where it ended up.</summary>
    private static async Task<(string Location, HttpClient Browser)> SignInAsync(WebApplicationFactory<Program> factory, FakeIdp idp, string sub, string email)
    {
        var browser = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            BaseAddress = new Uri("https://localhost"),
        });
        var click = await browser.GetAsync("/api/auth/login/sso/authentik");
        Assert.Equal(HttpStatusCode.Redirect, click.StatusCode);
        var authorize = HttpUtility.ParseQueryString(click.Headers.Location!.Query);
        Assert.Equal("https://localhost/signin-oidc/authentik", authorize["redirect_uri"]);
        idp.Nonce = authorize["nonce"]!;
        idp.Next = (sub, email);

        var back = await browser.GetAsync($"/signin-oidc/authentik?code=c0de&state={Uri.EscapeDataString(authorize["state"]!)}");
        Assert.Equal(HttpStatusCode.Redirect, back.StatusCode);
        return (back.Headers.Location!.ToString(), browser);
    }

    [Fact]
    public async Task AnExistingAccount_SignsInByEmail_ThenStaysLinkedBySubject()
    {
        var (factory, dir, idp) = NewApp();
        try
        {
            await AdminAsync(factory);
            var (location, browser) = await SignInAsync(factory, idp, "sub-1", "ADMIN@example.com");
            Assert.Equal("/", location);
            var me = await browser.GetFromJsonAsync<JsonElement>("/api/auth/me");
            Assert.Equal("admin", me.GetProperty("username").GetString());

            // The IdP later reports another address: the subject still finds the account.
            var (again, second) = await SignInAsync(factory, idp, "sub-1", "renamed@elsewhere.test");
            Assert.Equal("/", again);
            Assert.Equal("admin", (await second.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("username").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SomeoneWithoutAnAccount_IsToldSo_AndNoAccountIsCreated()
    {
        var (factory, dir, idp) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var (location, browser) = await SignInAsync(factory, idp, "sub-stranger", "stranger@example.com");
            Assert.Equal("/login?sso=no_account", location);
            Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
            var users = await admin.GetFromJsonAsync<JsonElement>("/api/auth/users");
            Assert.Single(users.EnumerateArray());

            // An IdP that sends no email at all is refused the same way.
            var (noEmail, _) = await SignInAsync(factory, idp, "sub-anon", "");
            Assert.Equal("/login?sso=no_account", noEmail);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ASecondIdentity_CantTakeOverAnAlreadyLinkedAccount()
    {
        var (factory, dir, idp) = NewApp();
        try
        {
            await AdminAsync(factory);
            Assert.Equal("/", (await SignInAsync(factory, idp, "sub-1", "admin@example.com")).Location);
            // Another person at the same IdP who sets their email to the admin's.
            Assert.Equal("/login?sso=no_account", (await SignInAsync(factory, idp, "sub-2", "admin@example.com")).Location);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ADisabledAccount_IsSentBackWithTheReason()
    {
        var (factory, dir, idp) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "bea@example.com", Password: "hunter2!", Role: "User"));
            var beaId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
            Assert.True((await admin.PostAsJsonAsync($"/api/auth/users/{beaId}/disable", new { })).IsSuccessStatusCode);

            Assert.Equal("/login?disabled=1", (await SignInAsync(factory, idp, "sub-bea", "bea@example.com")).Location);
        }
        finally { Cleanup(factory, dir); }
    }
}
