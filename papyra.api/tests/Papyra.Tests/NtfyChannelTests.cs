using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Features;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Tests;

// The shared connection rules, the ntfy provider against a fake ntfy server, and ntfy set-up end to end.
public sealed class NtfyChannelTests : IAsyncLifetime
{
    // A stand-in for ntfy on this machine. Answers whatever it is told to and remembers what it was sent.
    private sealed class FakeNtfy : IAsyncDisposable
    {
        // Headers are copied: the server reuses its request objects once the call has finished.
        public sealed record Seen(string Method, string Path, string Body, Dictionary<string, string> Headers);

        public List<Seen> Requests { get; } = [];
        public int Status = 200;
        public string? RetryAfter;
        private WebApplication? _app;

        public string Url { get; private set; } = string.Empty;

        public async Task StartAsync()
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            _app = builder.Build();
            _app.Run(async ctx =>
            {
                using var reader = new StreamReader(ctx.Request.Body);
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var h in ctx.Request.Headers) headers[h.Key] = h.Value.ToString();
                Requests.Add(new Seen(ctx.Request.Method, ctx.Request.Path.Value ?? "", await reader.ReadToEndAsync(), headers));
                ctx.Response.StatusCode = Status;
                if (RetryAfter is not null) ctx.Response.Headers["Retry-After"] = RetryAfter;
            });
            await _app.StartAsync();
            Url = _app.Urls.First();
        }

        public async ValueTask DisposeAsync()
        {
            if (_app is not null) await _app.DisposeAsync();
        }
    }

    private readonly FakeNtfy _server = new();
    private SqliteConnection _conn = null!;
    private ServiceProvider _sp = null!;

    public async Task InitializeAsync()
    {
        await _server.StartAsync();
        _conn = new SqliteConnection("DataSource=:memory:");
        _conn.Open();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
        services.AddDbContext<AppDbContext>(o => o.UseSqlite(_conn));
        services.AddSingleton<SecretBox>();
        services.AddSingleton<InstanceConfigStore>();
        _sp = services.BuildServiceProvider();
        using (var scope = _sp.CreateScope())
            scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();
    }

    public async Task DisposeAsync()
    {
        await _sp.DisposeAsync();
        _conn.Dispose();
        await _server.DisposeAsync();
    }

    private InstanceConfigStore Config => _sp.GetRequiredService<InstanceConfigStore>();
    private SecretBox Box => _sp.GetRequiredService<SecretBox>();

    private OutboundPolicy Policy(bool allowLoopback = true) => new(Config, allowLoopback);

    private ChannelDestination Destination(string? topic = "my-topic") => new()
    {
        Channel = NotificationCatalog.Ntfy, SecretSealed = topic is null ? null : Box.Seal(topic),
    };

    private async Task ConfigureAsync(string? token = null)
    {
        var values = new Dictionary<string, string?>
        {
            [ChannelKeys.Enabled(NotificationCatalog.Ntfy)] = "true",
            [ChannelKeys.NtfyServer] = _server.Url,
        };
        if (token is not null) values[ChannelKeys.NtfyToken] = token;
        await Config.SetAsync(values);
    }

    // ── Address rules ───────────────────────────────────────────────────────────

    [Theory]
    [InlineData("8.8.8.8", AddressClass.Public)]
    [InlineData("2606:4700:4700::1111", AddressClass.Public)]
    [InlineData("10.0.0.5", AddressClass.Private)]
    [InlineData("172.20.1.1", AddressClass.Private)]
    [InlineData("192.168.1.10", AddressClass.Private)]
    [InlineData("100.64.0.9", AddressClass.Private)]        // Tailscale
    [InlineData("fc00::1", AddressClass.Private)]
    [InlineData("::ffff:10.0.0.5", AddressClass.Private)]   // an IPv4 address written as IPv6
    [InlineData("127.0.0.1", AddressClass.Never)]
    [InlineData("::1", AddressClass.Never)]
    [InlineData("::ffff:127.0.0.1", AddressClass.Never)]
    [InlineData("0.0.0.0", AddressClass.Never)]
    [InlineData("169.254.169.254", AddressClass.Never)]     // cloud metadata
    [InlineData("100.100.100.200", AddressClass.Never)]     // Alibaba metadata, inside Tailscale's range
    [InlineData("fd00:ec2::254", AddressClass.Never)]       // AWS metadata over IPv6
    [InlineData("fe80::1", AddressClass.Never)]
    [InlineData("224.0.0.1", AddressClass.Never)]
    [InlineData("255.255.255.255", AddressClass.Never)]
    public void AddressesAreClassedByWhereTheySit(string ip, AddressClass expected) =>
        Assert.Equal(expected, OutboundPolicy.Classify(IPAddress.Parse(ip)));

    [Theory]
    [InlineData(" NTFY.Lan ", "ntfy.lan")]
    [InlineData("192.168.1.5", "192.168.1.5")]
    [InlineData("[::1]", "::1")]
    [InlineData("https://ntfy.lan", null)]
    [InlineData("ntfy.lan:8080", null)]
    [InlineData("ntfy.lan/path", null)]
    [InlineData("", null)]
    [InlineData("bad host", null)]
    public void AHostIsKeptAsABareLowercaseName(string input, string? expected) =>
        Assert.Equal(expected, OutboundPolicy.Normalize(input));

    [Fact]
    public void TheStoredList_ToleratesBlankLinesCommasAndRepeats() =>
        Assert.Equal(["a.lan", "10.0.0.2", "b.lan"], OutboundPolicy.ParseList("A.lan\n\n 10.0.0.2 ,a.lan; b.lan\nhttps://nope"));

    [Fact]
    public async Task AServerAddress_IsCheckedBeforeItIsAccepted()
    {
        var policy = Policy(allowLoopback: false);

        Assert.Equal(OutboundPolicy.Problems.NotAUrl, await policy.CheckUrlAsync("not a url", default));
        Assert.Equal(OutboundPolicy.Problems.NotAUrl, await policy.CheckUrlAsync("ftp://ntfy.example", default));
        Assert.Equal(OutboundPolicy.Problems.NeedsHttps, await policy.CheckUrlAsync("http://8.8.8.8", default));
        Assert.Null(await policy.CheckUrlAsync("https://8.8.8.8", default));
        Assert.Equal(OutboundPolicy.Problems.Blocked, await policy.CheckUrlAsync("https://127.0.0.1", default));
        Assert.Equal(OutboundPolicy.Problems.Blocked, await policy.CheckUrlAsync("https://169.254.169.254", default));
        Assert.Equal(OutboundPolicy.Problems.HostNotAllowed, await policy.CheckUrlAsync("https://10.1.2.3", default));
        Assert.Equal(OutboundPolicy.Problems.Unresolvable, await policy.CheckUrlAsync("https://no-such-host.invalid", default));
    }

    [Fact]
    public async Task AdminAllowedHost_OpensOwnNetworkAddresses_ButNeverTheForbiddenOnes()
    {
        await Config.SetAsync(new Dictionary<string, string?>
            { [OutboundPolicy.AllowedHostsKey] = "10.1.2.3\n169.254.169.254\n127.0.0.1" });
        var policy = Policy(allowLoopback: false);

        Assert.Null(await policy.CheckUrlAsync("https://10.1.2.3", default));
        Assert.Null(await policy.CheckUrlAsync("http://10.1.2.3:2586", default));        // plain http is fine on the list
        Assert.Equal(OutboundPolicy.Problems.HostNotAllowed, await policy.CheckUrlAsync("https://10.1.2.4", default));
        Assert.Equal(OutboundPolicy.Problems.Blocked, await policy.CheckUrlAsync("https://169.254.169.254", default));
        Assert.Equal(OutboundPolicy.Problems.Blocked, await policy.CheckUrlAsync("https://127.0.0.1", default));
    }

    [Fact]
    public async Task ThePolicyClient_RefusesThisMachine_AtTheMomentOfConnecting()
    {
        var policy = Policy(allowLoopback: false);

        var refused = await Assert.ThrowsAnyAsync<HttpRequestException>(() => policy.Client.GetAsync(_server.Url));
        Assert.True(OutboundPolicy.IsBlocked(refused));
        Assert.Empty(_server.Requests);

        // Listing the host does not help: this machine is never reachable.
        await Config.SetAsync(new Dictionary<string, string?> { [OutboundPolicy.AllowedHostsKey] = "127.0.0.1" });
        var stillRefused = await Assert.ThrowsAnyAsync<HttpRequestException>(() => policy.Client.GetAsync(_server.Url));
        Assert.True(OutboundPolicy.IsBlocked(stillRefused));
    }

    // ── The provider ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ANotification_IsPostedToTheTopic_WithTitleAndLink()
    {
        await ConfigureAsync();
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        var result = await ntfy.SendAsync(Destination("my-topic"),
            new ChannelMessage(NotificationCatalog.Mention, "You were mentioned in a note", "https://notes.example.com/?notifications=1"), default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        var seen = Assert.Single(_server.Requests);
        Assert.Equal("POST", seen.Method);
        Assert.Equal("/my-topic", seen.Path);
        Assert.Equal("You were mentioned in a note", seen.Body);
        Assert.Equal("Papyra", seen.Headers["Title"].ToString());
        Assert.Equal("https://notes.example.com/?notifications=1", seen.Headers["Click"].ToString());
        Assert.False(seen.Headers.ContainsKey("Authorization"));
    }

    [Fact]
    public async Task WithoutALink_NoClickHeaderIsSent_AndWithAToken_ItIsSentAsBearer()
    {
        await ConfigureAsync(token: "tk_secret");
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        await ntfy.SendAsync(Destination(), new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        var seen = Assert.Single(_server.Requests);
        Assert.False(seen.Headers.ContainsKey("Click"));
        Assert.Equal("Bearer tk_secret", seen.Headers["Authorization"].ToString());
    }

    [Fact]
    public async Task TheServerAddress_DefaultsToPublicNtfy_WhenBlank()
    {
        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.NtfyServer] = "" });
        Assert.Equal("https://ntfy.sh", NtfyChannel.ServerUrl(Config));

        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.NtfyServer] = "https://ntfy.home.lan/" });
        Assert.Equal("https://ntfy.home.lan", NtfyChannel.ServerUrl(Config));
    }

    [Fact]
    public async Task OnlyAnAdminTurnedOnChannel_IsAvailable()
    {
        var ntfy = new NtfyChannel(Config, Policy(), Box);
        await Config.EnsureLoadedAsync();
        Assert.False(ntfy.IsAvailable(Config));

        await ConfigureAsync();
        Assert.True(ntfy.IsAvailable(Config));
    }

    [Theory]
    [InlineData(500, ChannelOutcome.Retry)]
    [InlineData(503, ChannelOutcome.Retry)]
    [InlineData(408, ChannelOutcome.Retry)]
    [InlineData(429, ChannelOutcome.Retry)]
    [InlineData(401, ChannelOutcome.Rejected)]
    [InlineData(403, ChannelOutcome.Rejected)]
    [InlineData(404, ChannelOutcome.Rejected)]
    [InlineData(400, ChannelOutcome.Rejected)]
    public async Task EachAnswer_IsEitherWorthRetryingOrFinal(int status, ChannelOutcome expected)
    {
        await ConfigureAsync();
        _server.Status = status;
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        var result = await ntfy.SendAsync(Destination(), new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        Assert.Equal(expected, result.Outcome);
        Assert.False(string.IsNullOrWhiteSpace(result.Error));
    }

    [Fact]
    public async Task AskedToSlowDown_PapyraWaitsAsLongAsItWasToldTo()
    {
        await ConfigureAsync();
        _server.Status = 429;
        _server.RetryAfter = "120";
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        var result = await ntfy.SendAsync(Destination(), new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        Assert.Equal(TimeSpan.FromMinutes(2), result.RetryAfter);
    }

    [Fact]
    public async Task AServerThatIsNotThere_IsRetried_WithoutLeakingTheTopic()
    {
        await ConfigureAsync();
        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.NtfyServer] = "http://127.0.0.1:1" });
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        var result = await ntfy.SendAsync(Destination("very-secret-topic"),
            new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.DoesNotContain("very-secret-topic", result.Error);
    }

    [Fact]
    public async Task AServerThePolicyForbids_IsReportedClearly_AndNothingIsSent()
    {
        await ConfigureAsync();
        var ntfy = new NtfyChannel(Config, Policy(allowLoopback: false), Box);

        var result = await ntfy.SendAsync(Destination(), new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.Contains("allowed", result.Error);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task ADestinationWithoutATopic_IsRefused()
    {
        await ConfigureAsync();
        var ntfy = new NtfyChannel(Config, Policy(), Box);

        var result = await ntfy.SendAsync(Destination(topic: null), new ChannelMessage(NotificationCatalog.Mention, "Hi", null), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Empty(_server.Requests);
    }

    // ── Set-up, end to end ──────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-ntfy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            // The fake ntfy is on this machine, which the real policy never reaches.
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<OutboundPolicy>();
                s.AddSingleton(sp => new OutboundPolicy(sp.GetRequiredService<InstanceConfigStore>(), allowLoopback: true));
            });
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task TheAdminSetsNtfyUp_ThenAPersonConnectsTests_ConfirmsAndGetsNotified()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(
                new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"))).StatusCode);

            // Off until the admin turns it on.
            var before = await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications");
            Assert.False(before.GetProperty("ntfy").GetProperty("enabled").GetBoolean());
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/ntfy", new NtfySetupWrite(null))).StatusCode);

            // Server addresses are checked; an unsafe one is refused with a reason, and the list is untouched.
            var blocked = await admin.PutAsJsonAsync("/api/admin/notifications/ntfy", new NtfyAdminWrite(null, "https://169.254.169.254", null, true));
            Assert.Equal(HttpStatusCode.BadRequest, blocked.StatusCode);
            Assert.Equal("blocked", (await blocked.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            var plain = await admin.PutAsJsonAsync("/api/admin/notifications/ntfy", new NtfyAdminWrite(null, "http://10.9.8.7:2586", null, null));
            Assert.Equal("needs_https", (await plain.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            var lan = await admin.PutAsJsonAsync("/api/admin/notifications/ntfy", new NtfyAdminWrite(null, "https://10.9.8.7", null, null));
            Assert.Equal("host_not_allowed", (await lan.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Empty((await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications")).GetProperty("allowedHosts").EnumerateArray());

            // The fake server is this machine: "allow it" is the admin's explicit choice.
            var save = await admin.PutAsJsonAsync("/api/admin/notifications/ntfy",
                new NtfyAdminWrite(true, _server.Url, "tk_secret", true));
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);
            var after = await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications");
            Assert.True(after.GetProperty("ntfy").GetProperty("enabled").GetBoolean());
            Assert.True(after.GetProperty("ntfy").GetProperty("hasToken").GetBoolean());
            Assert.Contains("127.0.0.1", after.GetProperty("allowedHosts").EnumerateArray().Select(h => h.GetString()));
            Assert.DoesNotContain("tk_secret", await admin.GetStringAsync("/api/admin/notifications"));

            // The token is sealed in the database.
            using (var scope = factory.Services.CreateScope())
            {
                var raw = (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Settings
                    .FirstAsync(s => s.Key == ChannelKeys.NtfyToken)).Value;
                Assert.StartsWith(SecretBox.Prefix, raw);
            }

            // The admin can try a topic.
            var adminTest = await admin.PostAsJsonAsync("/api/admin/notifications/ntfy/test", new NtfyTestWrite("admin-trial"));
            Assert.True((await adminTest.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ok").GetBoolean());
            Assert.Equal("/admin-trial", _server.Requests.Last().Path);
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(
                "/api/admin/notifications/ntfy/test", new NtfyTestWrite("not a topic"))).StatusCode);

            // A person connects. The topic is generated, long, and starts unverified.
            var setup = await admin.PostAsJsonAsync("/api/notifications/destinations/ntfy", new NtfySetupWrite(null));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            var made = await setup.Content.ReadFromJsonAsync<JsonElement>();
            var id = made.GetProperty("id").GetInt32();
            var topic = made.GetProperty("topic").GetString()!;
            Assert.StartsWith("papyra-", topic);
            Assert.False(made.GetProperty("weakTopic").GetBoolean());
            Assert.Equal($"{_server.Url}/{topic}", made.GetProperty("subscribeUrl").GetString());

            var listed = (await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations")).GetProperty("destinations")[0];
            Assert.Equal("unverified", listed.GetProperty("state").GetString());
            Assert.DoesNotContain(topic, await admin.GetStringAsync("/api/notifications/destinations"));

            // Confirming needs a test that went through first.
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsync($"/api/notifications/destinations/{id}/confirm", null)).StatusCode);
            var test = await admin.PostAsync($"/api/notifications/destinations/{id}/test", null);
            Assert.True((await test.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ok").GetBoolean());
            var seen = _server.Requests.Last();
            Assert.Equal($"/{topic}", seen.Path);
            Assert.Equal("Bearer tk_secret", seen.Headers["Authorization"].ToString());
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/notifications/destinations/{id}/confirm", null)).StatusCode);
            Assert.Equal("connected", (await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations"))
                .GetProperty("destinations")[0].GetProperty("state").GetString());

            // The person can read their own topic back (to subscribe on a new device).
            var address = await admin.GetFromJsonAsync<JsonElement>($"/api/notifications/destinations/ntfy/{id}/address");
            Assert.Equal(topic, address.GetProperty("topic").GetString());

            // A real notification now reaches ntfy, as the generic line.
            var me = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();
            var before2 = _server.Requests.Count;
            using (var scope = factory.Services.CreateScope())
            {
                var user = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.FirstAsync(u => u.Id == me);
                factory.Services.GetRequiredService<EmailSender>().NotifyInBackground(
                    user, NotificationCatalog.Mention, "@bea mentioned you in “Private plan”", "body");
            }
            await factory.Services.GetRequiredService<ChannelDeliveryService>().ProcessAsync(CancellationToken.None);
            Assert.Equal(before2 + 1, _server.Requests.Count);
            var delivered = _server.Requests.Last();
            Assert.Equal($"/{topic}", delivered.Path);
            Assert.Equal("You were mentioned in a note", delivered.Body);

            // Connecting again replaces the topic.
            var again = await (await admin.PostAsJsonAsync("/api/notifications/destinations/ntfy", new NtfySetupWrite("shorty")))
                .Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(again.GetProperty("weakTopic").GetBoolean());
            Assert.Single((await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations"))
                .GetProperty("destinations").EnumerateArray());
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/ntfy", new NtfySetupWrite("has space"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APersonWhoIsNotAnAdmin_CannotTouchTheAdminSettings_OrReadAnotherPersonsTopic()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            await admin.PutAsJsonAsync("/api/admin/notifications/ntfy", new NtfyAdminWrite(true, _server.Url, null, true));
            var id = (await (await admin.PostAsJsonAsync("/api/notifications/destinations/ntfy", new NtfySetupWrite(null)))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

            var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@example.com", Password: "hunter2!", Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);
            var bea = factory.CreateClient();
            await bea.LoginAsync("bea", "hunter2!");
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/admin/notifications")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PutAsJsonAsync("/api/admin/notifications/ntfy",
                new NtfyAdminWrite(false, null, null, null))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PutAsJsonAsync("/api/admin/notifications/allowed-hosts",
                new AllowedHostsWrite(["10.0.0.1"]))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/notifications/destinations/ntfy/{id}/address")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/notifications/destinations/{id}/test", null)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/notifications/destinations/{id}/confirm", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheAllowedHostsList_IsValidated()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));

            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/api/admin/notifications/allowed-hosts",
                new AllowedHostsWrite(["https://ntfy.lan/path"]))).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync("/api/admin/notifications/allowed-hosts",
                new AllowedHostsWrite(["NTFY.lan", "192.168.1.5", "ntfy.lan", ""]))).StatusCode);

            var hosts = (await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications")).GetProperty("allowedHosts")
                .EnumerateArray().Select(h => h.GetString()).ToList();
            Assert.Equal(["ntfy.lan", "192.168.1.5"], hosts);
        }
        finally { Cleanup(factory, dir); }
    }
}
