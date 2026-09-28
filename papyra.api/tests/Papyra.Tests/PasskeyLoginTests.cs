using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Papyra.Tests;

// POST /api/auth/passkey/options + /verify — signing in with a registered
// biometric device. The ceremony itself is Fido2NetLib's (covered by its own
// tests); what is asserted here is what the endpoints give away: the options
// call must answer the same way for an account that exists, one that doesn't,
// and one with no passkey, so it is never a username or passkey oracle.
public sealed class PasskeyLoginTests
{
    private static WebApplicationFactory<Program> NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-passkey-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
    }

    private static async Task<HttpResponseMessage> OptionsAsync(HttpClient client, string username)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/auth/passkey/options")
        {
            Content = JsonContent.Create(new { username }),
        };
        req.Headers.Add("Origin", "http://localhost");
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Options_LookTheSame_WhetherOrNotTheAccountExists()
    {
        using var factory = NewApp();
        var client = factory.CreateClient();
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

        var anon = factory.CreateClient();
        foreach (var name in new[] { "admin", "nobody-here" })
        {
            var res = await OptionsAsync(anon, name);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var json = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrEmpty(json.GetProperty("challenge").GetString()));
            // One (decoy) credential either way: admin has no passkey registered.
            Assert.Equal(1, json.GetProperty("allowCredentials").GetArrayLength());
        }
    }

    [Fact]
    public async Task Options_NeedAUsername_AndVerify_NeedsAResponse()
    {
        using var factory = NewApp();
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.BadRequest, (await OptionsAsync(client, "  ")).StatusCode);

        var verify = await client.PostAsJsonAsync("/api/auth/passkey/verify", new { username = "admin" });
        Assert.Equal(HttpStatusCode.BadRequest, verify.StatusCode);
    }
}
