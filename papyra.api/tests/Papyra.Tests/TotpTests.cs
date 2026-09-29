using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Security;

namespace Papyra.Tests;

// The authenticator app: the RFC's own vectors, replay, and the places it stands
// in for an emailed code — setup on an instance with no mail, changing the
// account's email, and deleting the account.
public sealed class TotpTests
{
    // RFC 6238 appendix B, SHA-1 key "12345678901234567890" (8-digit vectors;
    // the six-digit code is their last six digits).
    [Theory]
    [InlineData(59L, "287082")]
    [InlineData(1111111109L, "081804")]
    [InlineData(1234567890L, "005924")]
    [InlineData(2000000000L, "279037")]
    public void Codes_MatchTheRfcVectors(long unixSeconds, string expected)
    {
        var key = Encoding.ASCII.GetBytes("12345678901234567890");
        Assert.Equal(expected, Totp.CodeAt(key, unixSeconds / Totp.StepSeconds));
    }

    [Fact]
    public void Base32_RoundTrips_AndForgivesHowPeopleTypeIt()
    {
        var bytes = Encoding.ASCII.GetBytes("12345678901234567890");
        var text = Totp.Base32Encode(bytes);
        Assert.Equal("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", text);
        Assert.Equal(bytes, Totp.Base32Decode("gezd gnbv-gy3tqojqgezdgnbvgy3tqojq=="));
    }

    [Fact]
    public void Match_AllowsOneStepOfDrift_AndRefusesReplay()
    {
        var secret = Totp.NewSecret();
        var now = DateTimeOffset.UtcNow;
        var step = Totp.StepAt(now);
        var key = Totp.Base32Decode(secret);

        Assert.Equal(step, Totp.Match(secret, Totp.CodeAt(key, step), now));
        Assert.Equal(step - 1, Totp.Match(secret, Totp.CodeAt(key, step - 1), now));
        Assert.Null(Totp.Match(secret, Totp.CodeAt(key, step - 3), now));
        // Already spent: the same code (or an older one) is refused.
        Assert.Null(Totp.Match(secret, Totp.CodeAt(key, step), now, lastUsedStep: step));
        Assert.Null(Totp.Match(secret, "12345", now));
        Assert.Null(Totp.Match("not base32!", "123456", now));
    }

    private static string Now(string secret, int offsetSteps = 0) =>
        Totp.CodeAt(Totp.Base32Decode(secret), Totp.StepAt(DateTimeOffset.UtcNow) + offsetSteps);

    private static async Task WithFreshAppAsync(Func<WebApplicationFactory<Program>, HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-totp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try { await body(factory, factory.CreateClient()); }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public Task Setup_WithNoMailServer_ProvesTheAdminWithAnAuthenticator() => WithFreshAppAsync(async (_, client) =>
    {
        var begun = await (await client.PostAsJsonAsync("/api/auth/setup/totp", new { account = "admin" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var secret = begun.GetProperty("secret").GetString()!;
        Assert.StartsWith("otpauth://totp/Papyra:admin?secret=" + secret, begun.GetProperty("uri").GetString());

        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PostAsJsonAsync("/api/auth/setup/totp/verify", new { secret, code = ((int.Parse(Now(secret)) + 500_000) % 1_000_000).ToString("D6") })).StatusCode);

        // No authenticator at all: the first admin can't be made without one.
        var none = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.BadRequest, none.StatusCode);
        Assert.Equal("totpCode", (await none.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("field").GetString());

        // Unproven, a wrong code stops setup before an account exists.
        var wrong = await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!", TotpSecret: secret, TotpCode: "12345"));
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/auth/setup/totp/verify", new { secret, code = Now(secret) })).StatusCode);

        // Proven early in the wizard, so the account is made minutes later with no fresh code.
        var ok = await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!", TotpSecret: secret));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var me = await client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.True(me.GetProperty("totpEnabled").GetBoolean());

        // Changing the email now asks for the authenticator, not the password.
        var ask = await (await client.PostAsJsonAsync("/api/auth/email/code", new { email = "new@b.c" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("totp", ask.GetProperty("method").GetString());
        var blocked = await client.PutAsJsonAsync("/api/auth/profile", new { email = "new@b.c" });
        Assert.Equal(HttpStatusCode.PreconditionRequired, blocked.StatusCode);
        Assert.Equal("totp_required", (await blocked.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var bad = await client.PutAsJsonAsync("/api/auth/profile", new { email = "new@b.c", totpCode = "12345" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        // The setup code was spent at step N; the next step's code is fresh.
        var next = Now(secret, 1);
        var moved = await client.PutAsJsonAsync("/api/auth/profile", new { email = "new@b.c", totpCode = next });
        Assert.Equal(HttpStatusCode.OK, moved.StatusCode);
        Assert.Equal("new@b.c", (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("email").GetString());

        // And it can't be used again.
        var replay = await client.PutAsJsonAsync("/api/auth/profile", new { email = "third@b.c", totpCode = next });
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);

        // With an authenticator, deletion no longer needs a mail server.
        var status = await client.GetFromJsonAsync<JsonElement>("/api/account/delete");
        Assert.True(status.GetProperty("totp").GetBoolean());
        Assert.DoesNotContain(status.GetProperty("blockers").EnumerateArray(), b => b.GetString()!.Contains("email"));
    });

    [Fact]
    public Task SettingsCanReplaceIt_WithThePassword_ButNotRemoveIt() => WithFreshAppAsync(async (_, client) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);
        // Setup enrolled one; replace it with a new app.
        Assert.True((await client.GetFromJsonAsync<JsonElement>("/api/auth/totp")).GetProperty("enabled").GetBoolean());

        var secret = (await (await client.PostAsync("/api/auth/totp/begin", null)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("secret").GetString()!;
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.PostAsJsonAsync("/api/auth/totp", new { secret, code = Now(secret), password = "wrong" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/auth/totp", new { secret, code = Now(secret), password = "hunter2!" })).StatusCode);
        Assert.True((await client.GetFromJsonAsync<JsonElement>("/api/auth/totp")).GetProperty("enabled").GetBoolean());

        // Every account keeps one: there is no way to remove it, only replace it.
        Assert.Equal(HttpStatusCode.NotFound,
            (await client.PostAsJsonAsync("/api/auth/totp/remove", new { password = "hunter2!" })).StatusCode);

        // And an admin always signs in with a code.
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PutAsJsonAsync("/api/auth/totp/login", new { enabled = false })).StatusCode);
    });

    [Fact]
    public Task TwoStepSignIn_AsksForTheCode_AndRememberedDevicesSkipIt() => WithFreshAppAsync(async (factory, admin) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);

        var browser = factory.CreateClient();
        var first = await (await browser.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "hunter2!", remember = true }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(first.GetProperty("twoFactorRequired").GetBoolean());
        var ticket = first.GetProperty("ticket").GetString();
        // The password alone signed nothing in.
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/notes")).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized,
            (await browser.PostAsJsonAsync("/api/auth/login/2fa", new { ticket, code = "12345" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK,
            (await browser.PostAsJsonAsync("/api/auth/login/2fa", new { ticket, code = TestAuth.TotpCode(browser) })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/notes")).StatusCode);

        // Same browser, signed out and back in: remembered, so no code this time.
        await browser.PostAsync("/api/auth/logout", null);
        var again = await (await browser.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "hunter2!" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(again.TryGetProperty("twoFactorRequired", out _));
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/notes")).StatusCode);
    });

    [Fact]
    public Task SignedInDevices_ListAndEnd() => WithFreshAppAsync(async (factory, admin) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);
        var laptop = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await laptop.LoginAsync("admin", "hunter2!")).StatusCode);

        var list = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/sessions")).EnumerateArray().ToList();
        Assert.Equal(2, list.Count);
        Assert.Single(list, s => s.GetProperty("current").GetBoolean());
        var other = list.Single(s => !s.GetProperty("current").GetBoolean()).GetProperty("id").GetInt32();

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/auth/sessions/{other}")).StatusCode);
        var ended = await laptop.GetAsync("/api/notes");
        Assert.Equal(HttpStatusCode.Unauthorized, ended.StatusCode);
        Assert.Equal("session_ended", (await ended.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/notes")).StatusCode);
    });

    [Fact]
    public Task AnAdminCanResetSomeonesAuthenticator() => WithFreshAppAsync(async (factory, admin) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);
        var made = await (await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: "bea", Name: "Bea", Email: "bea@example.com", Password: "hunter2!", Role: "User"))).Content.ReadFromJsonAsync<JsonElement>();
        var beaId = made.GetProperty("id").GetInt32();
        var bea = factory.CreateClient();
        await bea.LoginAsync("bea", "hunter2!");
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");
        Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/notes")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/auth/users/{beaId}/reset-2fa", null)).StatusCode);
        // Signed out everywhere; signing back in lands on setting a new one up.
        Assert.Equal(HttpStatusCode.Unauthorized, (await bea.GetAsync("/api/notes")).StatusCode);
        var back = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await back.LoginAsync("bea", "hunter2!")).StatusCode);
        var gated = await back.GetAsync("/api/notes");
        Assert.Equal("totp_setup_required", (await gated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // Only an admin can do it.
        Assert.Equal(HttpStatusCode.Forbidden, (await back.PostAsync($"/api/auth/users/{beaId}/reset-2fa", null)).StatusCode);
    });
}
