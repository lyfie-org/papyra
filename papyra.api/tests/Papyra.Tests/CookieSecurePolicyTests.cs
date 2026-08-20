using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// Whether the session cookie is marked `Secure`.
///
/// A `Secure` cookie is one the browser will only send back over a connection it
/// considers trustworthy. `localhost` always qualifies, so this never surfaces in
/// local testing — but a self-hoster reaching the container at a bare IP over
/// plain HTTP does not, and Chrome discards the cookie at login without a word.
/// Signing in appears to succeed and every refresh signs you out again.
///
/// `Papyra:AllowInsecureCookies` exists for a transport that is already private
/// (a WireGuard/Tailscale tunnel). It weakens a real defence, so the default is
/// what these tests mostly pin: OFF, and Secure regardless of how the request
/// arrived.
/// </summary>
public sealed class CookieSecurePolicyTests
{
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(
        string environment, bool? allowInsecureCookies)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-cookie-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.UseSetting("Papyra:DataDir", dir);
            if (allowInsecureCookies is { } v)
                b.UseSetting("Papyra:AllowInsecureCookies", v ? "true" : "false");
        });

        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        Directory.Delete(dir, recursive: true);
    }

    /// <summary>
    /// The `Set-Cookie` for the session, exactly as it went over the wire. The
    /// handler must not follow it into a cookie container, or the attribute we
    /// are asserting on is parsed away before the test can see it.
    /// </summary>
    private static async Task<string> SignInAndReadSetCookieAsync(
        WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            HandleCookies = false,
        });

        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        return Assert.Single(
            res.Headers.GetValues("Set-Cookie"),
            c => c.StartsWith("papyra.auth="));
    }

    [Fact]
    public async Task ByDefault_TheSessionCookieIsSecure()
    {
        var (factory, dir) = NewApp("Production", allowInsecureCookies: null);
        try
        {
            var cookie = await SignInAndReadSetCookieAsync(factory);
            Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ExplicitlyOff_TheSessionCookieIsStillSecure()
    {
        // The setting is opt-in; naming it false must not read as "do something".
        var (factory, dir) = NewApp("Production", allowInsecureCookies: false);
        try
        {
            var cookie = await SignInAndReadSetCookieAsync(factory);
            Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WhenAllowed_ThePlainHttpRequestGetsACookieItCanSendBack()
    {
        // The whole point: over http the cookie must NOT be Secure, or the browser
        // throws it away and the account can never stay signed in.
        var (factory, dir) = NewApp("Production", allowInsecureCookies: true);
        try
        {
            var cookie = await SignInAndReadSetCookieAsync(factory);
            Assert.DoesNotContain("secure", cookie, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WhenAllowed_TheCookieStaysHttpOnlyAndLax()
    {
        // Relaxing Secure is not licence to relax the rest: HttpOnly keeps the
        // cookie away from scripts, and Lax is what withholds it from cross-site
        // state-changing requests.
        var (factory, dir) = NewApp("Production", allowInsecureCookies: true);
        try
        {
            var cookie = await SignInAndReadSetCookieAsync(factory);
            Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("samesite=lax", cookie, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheFriendlyEnvironmentVariableNameWorksToo()
    {
        // PAPYRA_ALLOW_INSECURE_COOKIES is what a person running the container
        // would actually write. Proving the mapping in isolation is not enough:
        // this asserts it survives the whole configuration stack and reaches the
        // cookie handler.
        var dir = Path.Combine(Path.GetTempPath(), "papyra-cookie-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        Environment.SetEnvironmentVariable("PAPYRA_ALLOW_INSECURE_COOKIES", "true");
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Production");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var cookie = await SignInAndReadSetCookieAsync(factory);
            Assert.DoesNotContain("secure", cookie, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PAPYRA_ALLOW_INSECURE_COOKIES", null);
            Cleanup(factory, dir);
        }
    }

    [Fact]
    public async Task TheSessionActuallySurvivesTheNextRequestOverPlainHttp()
    {
        // The defect this setting answers was never visible in the login response
        // — that returned 200. It showed up one request later, so that is where
        // this asserts.
        var (factory, dir) = NewApp("Production", allowInsecureCookies: true);
        try
        {
            var client = factory.CreateClient();   // follows cookies, like a browser
            var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

            var me = await client.GetAsync("/api/auth/me");
            Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
