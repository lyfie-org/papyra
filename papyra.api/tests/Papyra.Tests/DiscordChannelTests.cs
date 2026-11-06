using System.Diagnostics;
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
using Papyra.Api.Data;
using Papyra.Api.Features;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Tests;

// Discord through a channel webhook: the address rules, the provider against a fake Discord, and set-up end to end.
public sealed class DiscordChannelTests : IAsyncLifetime
{
    private const string GoodToken = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef";
    private const string GoodWebhook = "https://discord.com/api/webhooks/123456789012345678/" + GoodToken;

    // A stand-in for Discord on this machine.
    private sealed class FakeDiscord : IAsyncDisposable
    {
        public sealed record Seen(string Method, string Path, string Body, Dictionary<string, string> Headers);

        public List<Seen> Requests { get; } = [];
        public int Status = 204;
        public string ResponseBody = "";
        public Dictionary<string, string> ResponseHeaders = new();
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
                foreach (var (k, v) in ResponseHeaders) ctx.Response.Headers[k] = v;
                if (ResponseBody.Length > 0)
                {
                    ctx.Response.ContentType = "application/json";
                    await ctx.Response.WriteAsync(ResponseBody);
                }
            });
            await _app.StartAsync();
            Url = _app.Urls.First();
        }

        public async ValueTask DisposeAsync()
        {
            if (_app is not null) await _app.DisposeAsync();
        }
    }

    private readonly FakeDiscord _server = new();
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

    private DiscordChannel Channel(bool trust = true) =>
        new(Config, new OutboundPolicy(Config, allowLoopback: true), Box) { TrustStoredAddress = trust };

    // A destination whose "webhook" is the fake server, so a send can be seen.
    private ChannelDestination LocalWebhook(string kind = DiscordChannel.WebhookKind) => new()
    {
        Channel = NotificationCatalog.Discord, Kind = kind,
        SecretSealed = Box.Seal($"{_server.Url}/api/webhooks/123456789012345678/{GoodToken}"),
    };

    private static ChannelMessage Message(string title = "You were mentioned in a note", string? link = null) =>
        new(NotificationCatalog.Mention, title, link);

    // ── Webhook addresses ───────────────────────────────────────────────────────

    [Theory]
    [InlineData(GoodWebhook)]
    [InlineData(GoodWebhook + "/")]
    [InlineData("  " + GoodWebhook + "  ")]
    [InlineData("https://discordapp.com/api/webhooks/123456789012345678/" + GoodToken)]
    [InlineData("https://canary.discord.com/api/webhooks/123456789012345678/" + GoodToken)]
    [InlineData("https://ptb.discord.com/api/webhooks/123456789012345678/" + GoodToken)]
    [InlineData("https://DISCORD.com/api/v10/webhooks/123456789012345678/" + GoodToken)]
    public void ARealWebhookAddress_IsAccepted(string input)
    {
        Assert.True(DiscordChannel.TryParseWebhook(input, out var address, out var id));
        Assert.StartsWith("https://", address);
        Assert.Equal("123456789012345678", id);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("http://discord.com/api/webhooks/123456789012345678/" + GoodToken)]                  // not https
    [InlineData("https://discord.com.evil.example/api/webhooks/123456789012345678/" + GoodToken)]    // another host
    [InlineData("https://evil.example/discord.com/api/webhooks/123456789012345678/" + GoodToken)]
    [InlineData("https://user:pw@discord.com/api/webhooks/123456789012345678/" + GoodToken)]         // credentials in the address
    [InlineData("https://discord.com:8443/api/webhooks/123456789012345678/" + GoodToken)]            // another port
    [InlineData(GoodWebhook + "?thread_id=1")]                                                      // extras
    [InlineData(GoodWebhook + "#x")]
    [InlineData("https://discord.com/api/webhooks/123456789012345678")]                             // no token
    [InlineData("https://discord.com/api/webhooks/12/" + GoodToken)]                                // short id
    [InlineData("https://discord.com/api/webhooks/123456789012345678/short")]                       // short token
    [InlineData("https://discord.com/api/webhooks/123456789012345678/" + GoodToken + "/extra")]
    [InlineData("https://discord.com/channels/123456789012345678/123456789012345678")]               // a channel link, not a webhook
    public void ASomethingElse_IsRefused(string? input) =>
        Assert.False(DiscordChannel.TryParseWebhook(input, out _, out _));

    // ── The provider ────────────────────────────────────────────────────────────

    [Fact]
    public async Task AMessage_IsPostedAsASmallCard_ThatCannotPingAnyone()
    {
        var result = await Channel().SendAsync(LocalWebhook(), Message("@everyone look", "https://notes.example.com/?notifications=1"), default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        var seen = Assert.Single(_server.Requests);
        Assert.Equal("POST", seen.Method);
        Assert.Equal($"/api/webhooks/123456789012345678/{GoodToken}", seen.Path);
        using var body = JsonDocument.Parse(seen.Body);
        Assert.Equal("Papyra", body.RootElement.GetProperty("username").GetString());
        Assert.Empty(body.RootElement.GetProperty("allowed_mentions").GetProperty("parse").EnumerateArray());
        var embed = Assert.Single(body.RootElement.GetProperty("embeds").EnumerateArray());
        Assert.Equal("@everyone look", embed.GetProperty("title").GetString());
        Assert.Equal("https://notes.example.com/?notifications=1", embed.GetProperty("url").GetString());
        Assert.Equal(0x7AAA8A, embed.GetProperty("color").GetInt32());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a link")]
    [InlineData("javascript:alert(1)")]
    public async Task WithoutAUsableLink_NoUrlIsSent(string? link)
    {
        await Channel().SendAsync(LocalWebhook(), Message(link: link), default);

        using var body = JsonDocument.Parse(Assert.Single(_server.Requests).Body);
        var embed = body.RootElement.GetProperty("embeds")[0];
        Assert.False(embed.TryGetProperty("url", out _));
    }

    [Fact]
    public async Task ALongTitle_IsClipped()
    {
        await Channel().SendAsync(LocalWebhook(), Message(new string('x', 600)), default);

        using var body = JsonDocument.Parse(Assert.Single(_server.Requests).Body);
        Assert.True(body.RootElement.GetProperty("embeds")[0].GetProperty("title").GetString()!.Length <= 250);
    }

    [Fact]
    public async Task WhenDiscordSaysNoneAreLeftInTheWindow_PapyraWaitsForTheWindow()
    {
        _server.ResponseHeaders = new() { ["X-RateLimit-Remaining"] = "0", ["X-RateLimit-Reset-After"] = "0.4" };
        var clock = Stopwatch.StartNew();

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        Assert.True(clock.Elapsed >= TimeSpan.FromMilliseconds(350), $"waited only {clock.Elapsed}");
    }

    [Fact]
    public async Task WithSendsLeft_ThereIsNoWait()
    {
        _server.ResponseHeaders = new() { ["X-RateLimit-Remaining"] = "3", ["X-RateLimit-Reset-After"] = "2" };
        var clock = Stopwatch.StartNew();

        await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task ARateLimit_IsRetried_AfterWhatDiscordAsked_FromTheHeader()
    {
        _server.Status = 429;
        _server.ResponseHeaders = new() { ["Retry-After"] = "3" };

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.Equal(TimeSpan.FromSeconds(3), result.RetryAfter);
    }

    [Fact]
    public async Task ARateLimit_WithoutTheHeader_UsesTheBodysWait()
    {
        _server.Status = 429;
        _server.ResponseBody = """{"message":"You are being rate limited.","retry_after":1.5,"global":false}""";

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(TimeSpan.FromSeconds(1.5), result.RetryAfter);
    }

    [Theory]
    [InlineData(404, ChannelOutcome.Rejected, "deleted")]
    [InlineData(401, ChannelOutcome.Rejected, "deleted")]
    [InlineData(403, ChannelOutcome.Rejected, "permissions")]
    [InlineData(400, ChannelOutcome.Rejected, "400")]
    [InlineData(408, ChannelOutcome.Retry, "too long")]
    [InlineData(500, ChannelOutcome.Retry, "500")]
    [InlineData(503, ChannelOutcome.Retry, "503")]
    public async Task EachAnswer_IsEitherWorthRetryingOrFinal(int status, ChannelOutcome expected, string saysSo)
    {
        _server.Status = status;

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(expected, result.Outcome);
        Assert.Contains(saysSo, result.Error);
    }

    [Fact]
    public async Task ADeletedWebhook_AsDiscordReportsIt_IsTheFinalKind()
    {
        _server.Status = 404;
        _server.ResponseBody = """{"message": "Unknown Webhook", "code": 10015}""";

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Contains("make a new one", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ABadRequest_NamesDiscordsErrorCode()
    {
        _server.Status = 400;
        _server.ResponseBody = """{"message": "Invalid Form Body", "code": 50035}""";

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Contains("50035", result.Error);
    }

    [Fact]
    public async Task WhenTheAdminForbidsWebhooks_NothingIsSent_AndItIsFinal()
    {
        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.DiscordWebhooksAllowed] = "false" });

        var result = await Channel().SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Contains("administrator", result.Error);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task OtherDiscordKinds_AreNotSentAsWebhooks()
    {
        var result = await Channel().SendAsync(LocalWebhook(kind: "dm"), Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task AStoredAddressThatIsNotADiscordWebhook_IsNeverCalled()
    {
        // Without the test allowance, the stored address is checked again before every send.
        var result = await Channel(trust: false).SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task ADestinationWithoutAnAddress_IsRefused()
    {
        var empty = new ChannelDestination { Channel = NotificationCatalog.Discord, Kind = DiscordChannel.WebhookKind };

        var result = await Channel().SendAsync(empty, Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public async Task ADiscordThatCannotBeReached_IsRetried_WithoutLeakingTheAddress()
    {
        var unreachable = new ChannelDestination
        {
            Channel = NotificationCatalog.Discord, Kind = DiscordChannel.WebhookKind,
            SecretSealed = Box.Seal($"http://127.0.0.1:1/api/webhooks/123456789012345678/{GoodToken}"),
        };

        var result = await Channel().SendAsync(unreachable, Message(), default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.DoesNotContain(GoodToken, result.Error);
    }

    [Fact]
    public async Task ADiscordTheNetworkRulesForbid_IsReportedClearly()
    {
        var strict = new DiscordChannel(Config, new OutboundPolicy(Config, allowLoopback: false), Box) { TrustStoredAddress = true };

        var result = await strict.SendAsync(LocalWebhook(), Message(), default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.Contains("not allowed", result.Error);
        Assert.Empty(_server.Requests);
    }

    [Fact]
    public async Task OnlyAWebhook_CanBeConfirmedByThePerson()
    {
        var discord = Channel();
        Assert.True(discord.CanBeConfirmedByPerson(LocalWebhook()));
        Assert.False(discord.CanBeConfirmedByPerson(LocalWebhook(kind: "dm")));
        await Task.CompletedTask;
    }

    // ── Set-up, end to end ──────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(Action<IServiceCollection>? more = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-discord-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.ConfigureTestServices(s => more?.Invoke(s));
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
    public async Task TheAdminTurnsDiscordOn_ThenAPersonConnectsAWebhook()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));

            // Off until switched on; a webhook can't be connected meanwhile.
            var before = await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications");
            Assert.False(before.GetProperty("discord").GetProperty("enabled").GetBoolean());
            Assert.True(before.GetProperty("discord").GetProperty("webhooksAllowed").GetBoolean());
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/discord/webhook", new DiscordWebhookWrite(GoodWebhook))).StatusCode);

            Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync(
                "/api/admin/notifications/discord", new DiscordAdminWrite(true, null))).StatusCode);

            // Anything that isn't a Discord webhook is turned away, with the steps to make one.
            var bad = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/webhook",
                new DiscordWebhookWrite("https://evil.example/api/webhooks/123456789012345678/" + GoodToken));
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
            Assert.Contains("Copy Webhook URL", await bad.Content.ReadAsStringAsync());
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(
                "/api/admin/notifications/discord/test", new DiscordWebhookWrite("nonsense"))).StatusCode);

            var made = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/webhook", new DiscordWebhookWrite(GoodWebhook));
            Assert.Equal(HttpStatusCode.OK, made.StatusCode);
            var body = await made.Content.ReadAsStringAsync();
            Assert.DoesNotContain(GoodToken, body);
            var id = JsonDocument.Parse(body).RootElement.GetProperty("id").GetInt32();

            // The address is sealed; only its numeric id is kept in the open.
            using (var scope = factory.Services.CreateScope())
            {
                var row = await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelDestinations.FirstAsync(d => d.Id == id);
                Assert.StartsWith(SecretBox.Prefix, row.SecretSealed);
                Assert.DoesNotContain(GoodToken, row.SecretSealed);
                Assert.Equal("123456789012345678", row.Handle);
                Assert.False(row.Verified);
            }
            var listed = await admin.GetStringAsync("/api/notifications/destinations");
            Assert.DoesNotContain(GoodToken, listed);
            Assert.DoesNotContain("123456789012345678", listed);
            Assert.Contains("\"state\":\"unverified\"", listed);

            // Nothing can be confirmed before a test message went through; then the person vouches for it.
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsync($"/api/notifications/destinations/{id}/confirm", null)).StatusCode);
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                (await db.ChannelDestinations.FirstAsync(d => d.Id == id)).LastOkUtc = DateTime.UtcNow;
                await db.SaveChangesAsync();
            }
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/notifications/destinations/{id}/confirm", null)).StatusCode);

            // Connecting again replaces it.
            var again = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/webhook", new DiscordWebhookWrite(GoodWebhook));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
            Assert.Single((await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations")).GetProperty("destinations").EnumerateArray());

            // Webhooks can be forbidden without turning Discord off.
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(null, false));
            var forbidden = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/webhook", new DiscordWebhookWrite(GoodWebhook));
            Assert.Equal(HttpStatusCode.Conflict, forbidden.StatusCode);
            Assert.Contains("administrator", await forbidden.Content.ReadAsStringAsync());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ADeliveryReachesTheWebhook_AsTheGenericLine_AndAPauseFollowsADeletedOne()
    {
        var (factory, dir) = NewApp(s =>
        {
            s.RemoveAll<OutboundPolicy>();
            s.AddSingleton(sp => new OutboundPolicy(sp.GetRequiredService<InstanceConfigStore>(), allowLoopback: true));
            s.RemoveAll<DiscordChannel>();
            s.AddSingleton(sp => new DiscordChannel(
                sp.GetRequiredService<InstanceConfigStore>(), sp.GetRequiredService<OutboundPolicy>(), sp.GetRequiredService<SecretBox>())
            { TrustStoredAddress = true });
        });
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(true, null));
            var me = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();

            int destId;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var box = scope.ServiceProvider.GetRequiredService<SecretBox>();
                var dest = new ChannelDestination
                {
                    UserId = me, Channel = NotificationCatalog.Discord, Kind = DiscordChannel.WebhookKind, Verified = true,
                    Label = "Discord · channel", CreatedUtc = DateTime.UtcNow,
                    SecretSealed = box.Seal($"{_server.Url}/api/webhooks/123456789012345678/{GoodToken}"),
                };
                db.ChannelDestinations.Add(dest);
                await db.SaveChangesAsync();
                destId = dest.Id;
            }

            var delivery = factory.Services.GetRequiredService<ChannelDeliveryService>();
            Assert.Contains("discord", delivery.AvailableChannels());

            async Task NotifyAsync()
            {
                using var scope = factory.Services.CreateScope();
                var user = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.FirstAsync(u => u.Id == me);
                factory.Services.GetRequiredService<EmailSender>().NotifyInBackground(
                    user, NotificationCatalog.Shared, "@bea shared “Plan” with you", "body");
                await delivery.ProcessAsync(CancellationToken.None);
            }

            await NotifyAsync();
            var seen = Assert.Single(_server.Requests);
            using (var json = JsonDocument.Parse(seen.Body))
                Assert.Equal("A note was shared with you", json.RootElement.GetProperty("embeds")[0].GetProperty("title").GetString());

            // Discord later says the webhook is gone: the destination is paused at once.
            _server.Status = 404;
            _server.ResponseBody = """{"message": "Unknown Webhook", "code": 10015}""";
            await NotifyAsync();
            using var check = factory.Services.CreateScope();
            var after = await check.ServiceProvider.GetRequiredService<AppDbContext>().ChannelDestinations.AsNoTracking().FirstAsync(d => d.Id == destId);
            Assert.NotNull(after.PausedUtc);
            Assert.Contains("deleted", after.LastError);
            Assert.Equal("paused", ChannelEndpoints.State(after));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APersonWhoIsNotAnAdmin_CannotChangeDiscordSettings()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "b@example.com", "hunter2!", "User"));
            var bea = factory.CreateClient();
            await bea.LoginAsync("bea", "hunter2!");
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PutAsJsonAsync(
                "/api/admin/notifications/discord", new DiscordAdminWrite(true, true))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsJsonAsync(
                "/api/admin/notifications/discord/test", new DiscordWebhookWrite(GoodWebhook))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
