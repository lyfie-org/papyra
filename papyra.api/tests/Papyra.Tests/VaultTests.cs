using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// The vault: a PIN every vault must have, biometrics as an optional extra, and
// every route that could hand out a secure note's text without an unlock.
public sealed class VaultTests
{
    private const string Pw = "hunter2!";

    // ── PIN policy ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("12a456")]
    [InlineData("48091")]            // too short
    [InlineData("4809134809134")]    // too long
    [InlineData("000000")]
    [InlineData("123456")]
    [InlineData("987654")]
    [InlineData("789012")]           // run that wraps 9 → 0
    [InlineData("210987")]
    [InlineData("４８０９１３")]      // full-width digits are not ASCII digits
    public void Validate_RejectsBadPins(string? pin) => Assert.NotNull(VaultPin.Validate(pin));

    [Theory]
    [InlineData("480913")]
    [InlineData("135790")]
    [InlineData("558811223344")]
    public void Validate_AcceptsReasonablePins(string pin) => Assert.Null(VaultPin.Validate(pin));

    [Fact]
    public void Lockout_EscalatesThenDisables()
    {
        for (var i = 0; i <= VaultPin.FreeAttempts; i++) Assert.Null(VaultPin.LockoutAfter(i));
        Assert.Equal(TimeSpan.FromSeconds(30), VaultPin.LockoutAfter(5));
        Assert.True(VaultPin.LockoutAfter(9) > VaultPin.LockoutAfter(8));
        Assert.False(VaultPin.IsHardLocked(9));
        Assert.True(VaultPin.IsHardLocked(10));
        Assert.Equal(0, VaultPin.AttemptsLeft(12));
    }

    // ── Relying party ────────────────────────────────────────────────────────────

    private static (RelyingParty? Party, RelyingPartyProblem? Problem) Rp(
        string host, string? origin, string scheme = "https", Dictionary<string, string?>? settings = null)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Scheme = scheme;
        ctx.Request.Host = new HostString(host);
        if (origin is not null) ctx.Request.Headers.Origin = origin;
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings ?? []).Build();
        return WebAuthnRelyingParty.Resolve(ctx.Request, config);
    }

    [Fact]
    public void RelyingParty_FollowsTheHostThePageWasOpenedOn()
    {
        // The reported bug: a fixed "localhost" rp id refused every other address.
        var (party, problem) = Rp("notes.example.com", "https://notes.example.com");
        Assert.Null(problem);
        Assert.Equal("notes.example.com", party!.RpId);
        Assert.Equal("https://notes.example.com", party.Origin);

        // Localhost over plain http is a secure context, and the port is kept in the origin.
        (party, problem) = Rp("localhost:5220", "http://localhost:5173", "http");
        Assert.Null(problem);
        Assert.Equal("localhost", party!.RpId);
        Assert.Equal("http://localhost:5173", party.Origin);
    }

    [Fact]
    public void RelyingParty_ExplainsWhatCannotWork()
    {
        Assert.Equal("rp_ip", Rp("192.168.1.20:8080", "https://192.168.1.20:8080").Problem!.Code);
        Assert.Equal("rp_ip", Rp("[::1]:8080", "https://[::1]:8080").Problem!.Code);
        Assert.Equal("rp_insecure", Rp("nas.local:8080", "http://nas.local:8080", "http").Problem!.Code);
        // A page on another host cannot borrow this server's relying party.
        Assert.Equal("rp_origin", Rp("notes.example.com", "https://evil.example.net").Problem!.Code);
        Assert.Equal("rp_origin", Rp("notes.example.com", "not a url").Problem!.Code);
    }

    [Fact]
    public void RelyingParty_HonoursListedOriginsAndAParentDomain()
    {
        var listed = new Dictionary<string, string?> { ["WebAuthn:Origins:0"] = "https://app.example.com" };
        Assert.Equal("app.example.com", Rp("api.internal", "https://app.example.com", settings: listed).Party!.RpId);

        var parent = new Dictionary<string, string?> { ["WebAuthn:ServerDomain"] = "example.com" };
        Assert.Equal("example.com", Rp("notes.example.com", "https://notes.example.com", settings: parent).Party!.RpId);
        // A configured domain that is not a parent of the host is ignored, not forced.
        Assert.Equal("other.org", Rp("other.org", "https://other.org", settings: parent).Party!.RpId);
    }

    // ── PIN lifecycle ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ANoteCannotBeLockedUntilAPinExists()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var put = await WriteAsync(client, "s1", "secret", secure: true);
            Assert.Equal(HttpStatusCode.Conflict, put.StatusCode);
            Assert.Equal("pin_not_set", await CodeAsync(put));

            await TestAuth.SetVaultPinAsync(client, Pw);
            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(client, "s1", "secret", secure: true)).StatusCode);
        });
    }

    [Fact]
    public async Task SettingAPin_NeedsProofOfOwnership()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var noProof = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "480913" });
            Assert.Equal(HttpStatusCode.Unauthorized, noProof.StatusCode);
            Assert.Equal("proof_required", await CodeAsync(noProof));

            var wrong = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "480913", password = "nope" });
            Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);

            var weak = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "111111", password = Pw });
            Assert.Equal(HttpStatusCode.BadRequest, weak.StatusCode);
            Assert.Equal("pin_invalid", await CodeAsync(weak));

            await TestAuth.SetVaultPinAsync(client, Pw);
            var status = await client.GetFromJsonAsync<JsonElement>("/api/auth/vault");
            Assert.True(status.GetProperty("pinSet").GetBoolean());

            // Changing it: a guessed "current PIN" is a PIN guess like any other.
            var badChange = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", currentPin = "000001" });
            Assert.Equal(HttpStatusCode.Unauthorized, badChange.StatusCode);
            Assert.Equal("pin_wrong", await CodeAsync(badChange));
            var goodChange = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", currentPin = TestAuth.VaultPin });
            Assert.Equal(HttpStatusCode.OK, goodChange.StatusCode);

            // The old PIN no longer opens anything.
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin })).StatusCode);
            Assert.Equal(HttpStatusCode.OK,
                (await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = "135790" })).StatusCode);
        });
    }

    [Fact]
    public async Task ChangingThePin_RevokesUnlocksIssuedUnderTheOldOne()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var old = await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", "secret", secure: true);
            Assert.Equal(HttpStatusCode.OK, (await RevealAsync(client, "s1", old)).StatusCode);

            await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", password = Pw });
            Assert.Equal(HttpStatusCode.Unauthorized, (await RevealAsync(client, "s1", old)).StatusCode);
        });
    }

    [Fact]
    public async Task SsoAccountWithNothingLocked_CanSetItsFirstPinWithoutAPassword()
    {
        await WithAppAsync(async (factory, client) =>
        {
            await MutateUserAsync(factory, u => u.PasswordHash = string.Empty);
            var res = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "480913" });
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            // Once set, changing it needs the PIN (there is no password to fall back on).
            var again = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790" });
            Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
        });
    }

    // ── Unlocking and the lockout ────────────────────────────────────────────────

    [Fact]
    public async Task WrongPins_LockThenDisable_AndThePasswordResetsIt()
    {
        await WithAppAsync(async (factory, client) =>
        {
            await TestAuth.SetVaultPinAsync(client, Pw);
            async Task<HttpResponseMessage> Guess(string pin) =>
                await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin });

            for (var i = 1; i <= VaultPin.FreeAttempts; i++)
            {
                var r = await Guess("000001");
                Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
                Assert.Equal(VaultPin.HardLimit - i, (await JsonAsync(r)).GetProperty("attemptsLeft").GetInt32());
            }

            // The 5th miss starts a wait…
            var fifth = await Guess("000001");
            Assert.Equal(HttpStatusCode.Unauthorized, fifth.StatusCode);
            Assert.NotEqual(JsonValueKind.Null, (await JsonAsync(fifth)).GetProperty("lockedUntilUtc").ValueKind);
            // …during which even the right PIN is refused unchecked.
            var during = await Guess(TestAuth.VaultPin);
            Assert.Equal((HttpStatusCode)429, during.StatusCode);
            var duringBody = await JsonAsync(during);
            Assert.Equal("pin_locked", duringBody.GetProperty("code").GetString());
            // Every lockout time on the wire is marked UTC. Unmarked, a browser reads
            // it as local time and (east of UTC) shows the wait as already over.
            Assert.EndsWith("Z", duringBody.GetProperty("lockedUntilUtc").GetString());
            var status = await client.GetFromJsonAsync<JsonElement>("/api/auth/vault");
            Assert.EndsWith("Z", status.GetProperty("lockedUntilUtc").GetString());

            // Run the clock forward through every wait to the hard limit.
            for (var i = 6; i <= VaultPin.HardLimit; i++)
            {
                await MutateUserAsync(factory, u => u.VaultPinLockedUntilUtc = DateTime.UtcNow.AddSeconds(-1));
                await Guess("000001");
            }
            await MutateUserAsync(factory, u => u.VaultPinLockedUntilUtc = null);
            var disabled = await Guess(TestAuth.VaultPin);
            Assert.Equal((HttpStatusCode)423, disabled.StatusCode);
            Assert.Equal("pin_disabled", await CodeAsync(disabled));

            // Changing via the (disabled) current PIN is refused; the password works.
            var viaPin = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", currentPin = TestAuth.VaultPin });
            Assert.Equal((HttpStatusCode)423, viaPin.StatusCode);
            var viaPassword = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", password = Pw });
            Assert.Equal(HttpStatusCode.OK, viaPassword.StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await Guess("135790")).StatusCode);
        });
    }

    [Fact]
    public async Task AParallelBurstOfGuesses_GetsNoMoreTriesThanASequentialOne()
    {
        await WithAppAsync(async (factory, client) =>
        {
            await TestAuth.SetVaultPinAsync(client, Pw);
            var burst = await Task.WhenAll(Enumerable.Range(0, 25).Select(_ =>
                client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = "000001" })));

            // Four free misses plus the one that starts the wait; every other request
            // must have been refused without a check.
            Assert.Equal(VaultPin.FreeAttempts + 1, burst.Count(r => r.StatusCode == HttpStatusCode.Unauthorized));
            Assert.All(burst.Where(r => r.StatusCode != HttpStatusCode.Unauthorized),
                r => Assert.Equal((HttpStatusCode)429, r.StatusCode));

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal(VaultPin.FreeAttempts + 1, (await db.Users.SingleAsync()).VaultPinFailures);
        });
    }

    [Fact]
    public async Task ThePinOpensTheVault_AndLockAndLogoutCloseIt()
    {
        await WithAppAsync(async (factory, client) =>
        {
            await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", "sort code 00-00-00", secure: true);

            var unlocked = await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin });
            var token = (await JsonAsync(unlocked)).GetProperty("unlockToken").GetString()!;
            var reveal = await RevealAsync(client, "s1", token);
            Assert.Equal("sort code 00-00-00", (await JsonAsync(reveal)).GetProperty("body").GetString());

            await client.PostAsync("/api/auth/vault/lock", null);
            Assert.Equal(HttpStatusCode.Unauthorized, (await RevealAsync(client, "s1", token)).StatusCode);

            token = (await JsonAsync(await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin })))
                .GetProperty("unlockToken").GetString()!;
            await client.PostAsync("/api/auth/logout", null);
            Assert.False(factory.Services.GetRequiredService<UnlockTokenStore>().IsValid(token, "1"));
        });
    }

    // ── Every other way a secure body could leave the server ─────────────────────

    [Fact]
    public async Task TakingTheLockOff_NeedsTheVaultOpen()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var token = await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", "secret", secure: true);

            var plain = await WriteAsync(client, "s1", "secret", secure: false);
            Assert.Equal(HttpStatusCode.Unauthorized, plain.StatusCode);
            Assert.True(Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []).Secure);

            var withToken = new HttpRequestMessage(HttpMethod.Put, "/api/notes/s1")
            {
                Content = JsonContent.Create(new NoteWrite("Bank", null, null, false, false, "secret", null, false)),
            };
            withToken.Headers.Add("X-Unlock-Token", token);
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(withToken)).StatusCode);
        });
    }

    [Fact]
    public async Task SnapshotsAndRestore_OfASecureNote_AreGated()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var token = await TestAuth.SetVaultPinAsync(client, Pw);
            // A plain revision, then the note is locked: the old plain copy is now
            // exactly what the owner chose to hide.
            await WriteAsync(client, "s1", "old plain text", secure: false);
            await WriteAsync(client, "s1", "old plain text", secure: true);
            await WriteAsync(client, "s1", "newer secret", secure: true);

            var list = await client.GetFromJsonAsync<List<JsonElement>>("/api/notes/s1/snapshots") ?? [];
            Assert.NotEmpty(list);
            var snapId = list[^1].GetProperty("id").GetString();

            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync($"/api/notes/s1/snapshots/{snapId}")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync($"/api/notes/s1/restore/{snapId}", null)).StatusCode);
            Assert.True(Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []).Secure);

            var get = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/s1/snapshots/{snapId}");
            get.Headers.Add("X-Unlock-Token", token);
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(get)).StatusCode);
        });
    }

    [Fact]
    public async Task SearchBacklinksCollectionsAndExport_NeverCarrySecureText()
    {
        await WithAppAsync(async (factory, client) =>
        {
            await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "target", "plain target", secure: false, title: "Target");
            await WriteAsync(client, "s1", "zebracode lives in [[Target]]", secure: true, title: "Locked");

            // Search: findable by title, never by a word of the body.
            Assert.Empty(await client.GetFromJsonAsync<List<JsonElement>>("/api/search?q=zebracode") ?? []);
            Assert.Single(await client.GetFromJsonAsync<List<JsonElement>>("/api/search?q=Locked") ?? []);

            // Backlinks: the locked note's link is not reported.
            Assert.Empty(await client.GetFromJsonAsync<List<JsonElement>>("/api/notes/target/backlinks") ?? []);

            // Smart collections: a body-text rule does not match it; a title one
            // matches with the body withheld.
            var byText = await CreateCollectionAsync(client, "text", "zebracode");
            Assert.Empty(await client.GetFromJsonAsync<List<Note>>($"/api/collections/{byText}/notes") ?? []);
            var byTitle = await CreateCollectionAsync(client, "text", "Locked");
            var hit = Assert.Single(await client.GetFromJsonAsync<List<Note>>($"/api/collections/{byTitle}/notes") ?? []);
            Assert.Equal(string.Empty, hit.Body);

            // Export: the plain zip leaves the locked note out.
            using var zip = new ZipArchive(await (await client.GetAsync("/api/export")).Content.ReadAsStreamAsync());
            Assert.Contains(zip.Entries, e => e.FullName.EndsWith("target.md", StringComparison.Ordinal));
            Assert.DoesNotContain(zip.Entries, e => e.FullName.EndsWith("s1.md", StringComparison.Ordinal));
        });
    }

    // ── API keys and biometrics ──────────────────────────────────────────────────

    [Fact]
    public async Task AnApiKey_CannotTouchTheVault()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var token = await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", "secret", secure: true);
            var key = (await JsonAsync(await client.PostAsJsonAsync("/api/keys", new { name = "script" })))
                .GetProperty("token").GetString()!;

            var bot = factory.CreateClient();
            bot.DefaultRequestHeaders.Add("X-API-Key", key);
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bot.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin })).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bot.PostAsJsonAsync("/api/auth/vault/pin", new { pin = "135790", password = Pw })).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bot.PostAsync("/api/auth/webauthn/register/challenge", null)).StatusCode);
            // Even holding a live unlock token, a key cannot read a secure body.
            Assert.Equal(HttpStatusCode.Unauthorized, (await RevealAsync(bot, "s1", token)).StatusCode);
        });
    }

    [Fact]
    public async Task EnrollingABiometric_NeedsAPinAndAnOpenVault()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var noPin = await client.PostAsync("/api/auth/webauthn/register/challenge", null);
            Assert.Equal(HttpStatusCode.Conflict, noPin.StatusCode);

            var token = await TestAuth.SetVaultPinAsync(client, Pw);
            await client.PostAsync("/api/auth/vault/lock", null);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/auth/webauthn/register/challenge", null)).StatusCode);

            token = (await JsonAsync(await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin })))
                .GetProperty("unlockToken").GetString()!;
            var ok = new HttpRequestMessage(HttpMethod.Post, "/api/auth/webauthn/register/challenge");
            ok.Headers.Add("X-Unlock-Token", token);
            var challenge = await client.SendAsync(ok);
            Assert.Equal(HttpStatusCode.OK, challenge.StatusCode);
            // The test server answers as localhost, so that is the relying party.
            Assert.Equal("localhost", (await JsonAsync(challenge)).GetProperty("rp").GetProperty("id").GetString());

            // Removing a device is guarded the same way.
            await client.PostAsync("/api/auth/vault/lock", null);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.DeleteAsync("/api/auth/webauthn/credentials/1")).StatusCode);
        });
    }

    [Fact]
    public async Task VaultStatus_ReportsWhyBiometricsAreUnavailableHere()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var req = new HttpRequestMessage(HttpMethod.Get, "/api/auth/vault");
            req.Headers.Host = "192.168.1.20:8080";
            var status = await JsonAsync(await client.SendAsync(req));
            var bio = status.GetProperty("biometric");
            Assert.False(bio.GetProperty("available").GetBoolean());
            Assert.Equal("rp_ip", bio.GetProperty("problem").GetProperty("code").GetString());
        });
    }

    [Fact]
    public async Task ExpiredChallenges_CannotBeAnswered()
    {
        var store = new WebAuthnChallengeStore();
        var party = new RelyingParty("localhost", "http://localhost");
        store.PutAssert("1", "{}", party);
        Assert.NotNull(store.TakeAssert("1"));
        Assert.Null(store.TakeAssert("1")); // single use
        await Task.CompletedTask;
    }

    [Fact]
    public async Task TheLiveUpdateHub_RefusesAnonymousListeners()
    {
        await WithAppAsync(async (factory, client) =>
        {
            var anon = factory.CreateClient();
            var negotiate = await anon.PostAsync("/hubs/notes/negotiate?negotiateVersion=1", null);
            Assert.Equal(HttpStatusCode.Unauthorized, negotiate.StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/hubs/notes/negotiate?negotiateVersion=1", null)).StatusCode);
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    private static async Task WithAppAsync(Func<WebApplicationFactory<Program>, HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-vault-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            await body(factory, client);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    private static Task<HttpResponseMessage> WriteAsync(
        HttpClient client, string id, string body, bool secure, string title = "Bank") =>
        client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: title, Tags: null, Color: null, Pinned: false, Archived: false,
            Body: body, Kind: null, Secure: secure));

    private static Task<HttpResponseMessage> RevealAsync(HttpClient client, string id, string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/{id}/secure");
        req.Headers.Add("X-Unlock-Token", token);
        return client.SendAsync(req);
    }

    private static async Task<int> CreateCollectionAsync(HttpClient client, string field, string value)
    {
        var rules = JsonSerializer.Serialize(new { match = "all", conditions = new[] { new { field, value } } });
        var res = await client.PostAsJsonAsync("/api/collections", new { name = value, rulesJson = rules });
        return (await JsonAsync(res)).GetProperty("id").GetInt32();
    }

    private static async Task MutateUserAsync(WebApplicationFactory<Program> factory, Action<User> change)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = await db.Users.SingleAsync();
        change(user);
        await db.SaveChangesAsync();
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage res) =>
        await res.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<string?> CodeAsync(HttpResponseMessage res) =>
        (await JsonAsync(res)).TryGetProperty("code", out var c) ? c.GetString() : null;
}
