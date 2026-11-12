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

// Discord direct messages through the admin's bot: the API calls against a fake Discord, the provider, and
// the set-up that proves a Discord account is the person's with a code the bot sends there.
public sealed class DiscordDirectTests : IAsyncLifetime
{
    private const string BotToken = "BOT.SECRET.token-value";
    private const string UserId = "123456789012345678";

    // A stand-in for discord.com/api/v10 on this machine.
    private sealed class FakeDiscordApi : IAsyncDisposable
    {
        public sealed record Call(string Method, string Path, string Auth, JsonElement Body);

        public List<Call> Calls { get; } = [];
        public Func<string, string, (int Status, string Json, string? RetryAfter)> Handler =
            (_, path) => path.EndsWith("/users/@me", StringComparison.Ordinal) ? (200, """{"id":"900","username":"PapyraBot"}""", null)
                : path.EndsWith("/users/@me/channels", StringComparison.Ordinal) ? (200, """{"id":"555","type":1}""", null)
                : (200, """{"id":"1"}""", null);
        private WebApplication? _app;

        public string Url { get; private set; } = string.Empty;
        public string ApiBase => Url + "/api/v10";

        public IEnumerable<Call> Messages => Calls.Where(c => c.Path.Contains("/messages", StringComparison.Ordinal));
        public IEnumerable<Call> Opened => Calls.Where(c => c.Path.EndsWith("/users/@me/channels", StringComparison.Ordinal));

        public async Task StartAsync()
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            _app = builder.Build();
            _app.Run(async ctx =>
            {
                using var reader = new StreamReader(ctx.Request.Body);
                var raw = await reader.ReadToEndAsync();
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
                var path = ctx.Request.Path.Value ?? "";
                Calls.Add(new Call(ctx.Request.Method, path, ctx.Request.Headers.Authorization.ToString(), doc.RootElement.Clone()));
                var (status, json, retry) = Handler(ctx.Request.Method, path);
                ctx.Response.StatusCode = status;
                if (retry is not null) ctx.Response.Headers["Retry-After"] = retry;
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync(json);
            });
            await _app.StartAsync();
            Url = _app.Urls.First();
        }

        public async ValueTask DisposeAsync()
        {
            if (_app is not null) await _app.DisposeAsync();
        }
    }

    private readonly FakeDiscordApi _server = new();
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
    private OutboundPolicy Policy => new(Config, allowLoopback: true);
    private DiscordBot NewBot() => new(Policy) { ApiBase = _server.ApiBase };

    private Task ConfigureAsync(bool withToken = true) => Config.SetAsync(new Dictionary<string, string?>
    {
        [ChannelKeys.Enabled(NotificationCatalog.Discord)] = "true",
        [ChannelKeys.DiscordBotToken] = withToken ? BotToken : "",
    });

    private DiscordChannel Channel(DiscordBot? bot) =>
        new(Config, Policy, _sp.GetRequiredService<SecretBox>(), bot);

    private static ChannelDestination Direct(string handle = UserId) =>
        new() { Channel = NotificationCatalog.Discord, Kind = DiscordChannel.DirectKind, Handle = handle };

    private static ChannelMessage Message() => new(NotificationCatalog.Mention, "You were mentioned in a note", "https://notes.example.com/?notifications=1");

    // ── The bot's API calls ─────────────────────────────────────────────────────

    [Fact]
    public async Task AskedWhoItIs_TheBotNamesItself()
    {
        var (info, error) = await NewBot().GetMeAsync(BotToken, default);

        Assert.Null(error);
        Assert.Equal(("900", "PapyraBot"), (info!.Id, info.Username));
        Assert.Equal($"Bot {BotToken}", _server.Calls.Single().Auth);
    }

    [Fact]
    public async Task AWrongBotToken_IsCaughtWithAPlainReason()
    {
        _server.Handler = (_, _) => (401, """{"message":"401: Unauthorized","code":0}""", null);

        var (info, error) = await NewBot().GetMeAsync(BotToken, default);

        Assert.Null(info);
        Assert.Contains("Reset Token", error);
    }

    [Fact]
    public async Task ADiscordThatCannotBeReached_NeverPutsTheTokenInItsWords()
    {
        var offline = new DiscordBot(Policy) { ApiBase = "http://127.0.0.1:1/api/v10" };

        var (_, error) = await offline.GetMeAsync(BotToken, default);
        var send = await offline.SendAsync(BotToken, UserId, new { content = "hi" }, default);

        Assert.DoesNotContain("SECRET", error);
        Assert.DoesNotContain("SECRET", send.Error);
        Assert.Equal(ChannelOutcome.Retry, send.Outcome);
    }

    [Fact]
    public async Task ADirectMessage_OpensTheConversationOnce_ThenPostsIntoIt()
    {
        var bot = NewBot();

        var first = await bot.SendAsync(BotToken, UserId, new { content = "one" }, default);
        var second = await bot.SendAsync(BotToken, UserId, new { content = "two" }, default);

        Assert.Equal(ChannelOutcome.Sent, first.Outcome);
        Assert.Equal(ChannelOutcome.Sent, second.Outcome);
        var open = Assert.Single(_server.Opened);                            // the conversation is remembered
        Assert.Equal(UserId, open.Body.GetProperty("recipient_id").GetString());
        Assert.Equal(["/api/v10/channels/555/messages", "/api/v10/channels/555/messages"], _server.Messages.Select(c => c.Path));
        Assert.All(_server.Calls, c => Assert.Equal($"Bot {BotToken}", c.Auth));
    }

    [Fact]
    public async Task AConversationDiscordForgot_IsOpenedAgain()
    {
        var bot = NewBot();
        await bot.SendAsync(BotToken, UserId, new { content = "one" }, default);
        var answers = new Queue<(int, string, string?)>([(404, """{"message":"Unknown Channel","code":10003}""", null)]);
        var original = _server.Handler;
        _server.Handler = (m, p) => p.Contains("/messages") && answers.Count > 0 ? answers.Dequeue() : original(m, p);

        var lost = await bot.SendAsync(BotToken, UserId, new { content = "two" }, default);
        var again = await bot.SendAsync(BotToken, UserId, new { content = "three" }, default);

        Assert.Equal(ChannelOutcome.Rejected, lost.Outcome);
        Assert.Equal(ChannelOutcome.Sent, again.Outcome);
        Assert.Equal(2, _server.Opened.Count());                             // opened afresh for the third
    }

    [Theory]
    [InlineData(403, """{"message":"Cannot send messages to this user","code":50007}""", ChannelOutcome.Rejected, "allow direct messages")]
    [InlineData(404, """{"message":"Unknown User","code":10013}""", ChannelOutcome.Rejected, "can't find that user")]
    [InlineData(400, """{"message":"Invalid Form Body","code":50035}""", ChannelOutcome.Rejected, "can't find that user")]
    [InlineData(401, """{"message":"401: Unauthorized","code":0}""", ChannelOutcome.Retry, "administrator")]
    [InlineData(500, """{"message":"oops","code":0}""", ChannelOutcome.Retry, "500")]
    [InlineData(418, """{"message":"teapot","code":0}""", ChannelOutcome.Rejected, "418")]
    public async Task EachAnswerWhenOpeningTheConversation_IsEitherWorthRetryingOrFinal(int status, string json, ChannelOutcome expected, string saysSo)
    {
        _server.Handler = (_, _) => (status, json, null);

        var result = await NewBot().SendAsync(BotToken, UserId, new { content = "hi" }, default);

        Assert.Equal(expected, result.Outcome);
        Assert.Contains(saysSo, result.Error);
    }

    [Fact]
    public async Task ARateLimit_IsRetriedAfterWhatDiscordAsked()
    {
        _server.Handler = (_, _) => (429, """{"message":"You are being rate limited.","retry_after":2.5,"global":false}""", null);

        var result = await NewBot().SendAsync(BotToken, UserId, new { content = "hi" }, default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.Equal(TimeSpan.FromSeconds(2.5), result.RetryAfter);
    }

    // ── The provider ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ANotification_ReachesTheUsersDirectMessages_AsTheSmallCard()
    {
        await ConfigureAsync();

        var result = await Channel(NewBot()).SendAsync(Direct(), Message(), default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        var body = Assert.Single(_server.Messages).Body;
        Assert.Empty(body.GetProperty("allowed_mentions").GetProperty("parse").EnumerateArray());
        var embed = Assert.Single(body.GetProperty("embeds").EnumerateArray());
        Assert.Equal("You were mentioned in a note", embed.GetProperty("title").GetString());
        Assert.Equal("https://notes.example.com/?notifications=1", embed.GetProperty("url").GetString());
        Assert.False(body.TryGetProperty("username", out _));               // it is the bot's own conversation
    }

    [Fact]
    public async Task WithoutABot_NothingIsSent_AndItIsAnAdminsProblemNotThePersons()
    {
        await ConfigureAsync(withToken: false);

        var noToken = await Channel(NewBot()).SendAsync(Direct(), Message(), default);
        var noBot = await Channel(null).SendAsync(Direct(), Message(), default);

        Assert.Equal(ChannelOutcome.Retry, noToken.Outcome);
        Assert.Equal(ChannelOutcome.Retry, noBot.Outcome);
        Assert.Contains("administrator", noToken.Error);
        Assert.Empty(_server.Calls);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-number")]
    [InlineData("123")]
    public async Task ADestinationWithoutAUserId_IsRefused(string handle)
    {
        await ConfigureAsync();

        var result = await Channel(NewBot()).SendAsync(Direct(handle), Message(), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Empty(_server.Calls);
    }

    [Fact]
    public async Task ADirectMessage_IsConfirmedWithACode_NotByTheirSayingSo()
    {
        var discord = Channel(NewBot());
        Assert.False(discord.CanBeConfirmedByPerson(Direct()));
        await Task.CompletedTask;
    }

    [Fact]
    public async Task DirectMessagesAreAvailable_OnceABotTokenIsSaved()
    {
        await Config.EnsureLoadedAsync();
        Assert.False(DiscordChannel.DirectMessagesAvailable(Config));
        await ConfigureAsync();
        Assert.True(DiscordChannel.DirectMessagesAvailable(Config));
    }

    [Theory]
    [InlineData("ABCD-EFGH", "abcdefgh")]
    [InlineData(" abcd efgh ", "abcdefgh")]
    [InlineData("a2b3-c4d5", "a2b3c4d5")]
    [InlineData(null, "")]
    public void ACodeIsReadTheWayAPersonTypesIt(string? typed, string expected) =>
        Assert.Equal(expected, LinkCodes.Normalize(typed));

    // ── Set-up, end to end ──────────────────────────────────────────────────────

    private (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-dm-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<OutboundPolicy>();
                s.AddSingleton(sp => new OutboundPolicy(sp.GetRequiredService<InstanceConfigStore>(), allowLoopback: true));
                s.RemoveAll<DiscordBot>();
                s.AddSingleton(sp => new DiscordBot(sp.GetRequiredService<OutboundPolicy>()) { ApiBase = _server.ApiBase });
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

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var admin = factory.CreateClient();
        await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
        return admin;
    }

    // The code the bot "sent": it is in the text of the message the fake received.
    private string CodeSent()
    {
        var content = _server.Messages.First(c => c.Body.TryGetProperty("content", out _)).Body.GetProperty("content").GetString()!;
        var start = content.IndexOf("**", StringComparison.Ordinal) + 2;
        return content[start..content.IndexOf("**", start, StringComparison.Ordinal)];
    }

    [Fact]
    public async Task TheAdminAddsTheBot_ThenAPersonConnectsWithACode()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            // Nothing to connect until Discord has a bot. (Each of these requests counts toward the pace limit: six a minute.)
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(true, null));
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId))).StatusCode);

            // A wrong token is caught on the spot; the right one is sealed and the bot named.
            _server.Handler = (_, _) => (401, """{"message":"401: Unauthorized","code":0}""", null);
            var wrong = await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(null, null, "wrong"));
            Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
            _server.Handler = new FakeDiscordApi().Handler;
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync(
                "/api/admin/notifications/discord", new DiscordAdminWrite(null, null, BotToken))).StatusCode);

            var settings = await admin.GetStringAsync("/api/admin/notifications");
            Assert.DoesNotContain("SECRET", settings);
            var discord = JsonDocument.Parse(settings).RootElement.GetProperty("discord");
            Assert.True(discord.GetProperty("hasBotToken").GetBoolean());
            Assert.Equal("PapyraBot", discord.GetProperty("botUsername").GetString());
            using (var scope = factory.Services.CreateScope())
            {
                var raw = (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Settings
                    .FirstAsync(s => s.Key == ChannelKeys.DiscordBotToken)).Value;
                Assert.StartsWith(SecretBox.Prefix, raw);
            }
            Assert.True((await (await admin.PostAsync("/api/admin/notifications/discord/check-bot", null))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ok").GetBoolean());

            // The person's screen learns both ways are open.
            var kinds = (await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations")).GetProperty("discord");
            Assert.True(kinds.GetProperty("dm").GetBoolean());
            Assert.True(kinds.GetProperty("webhook").GetBoolean());

            // A made-up id never reaches Discord.
            var calls = _server.Calls.Count;
            var bad = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite("rahul"));
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
            Assert.Contains("Copy User ID", await bad.Content.ReadAsStringAsync());
            Assert.Equal(calls, _server.Calls.Count);

            // The bot sends a code; the destination exists but is not confirmed.
            var made = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId));
            Assert.Equal(HttpStatusCode.OK, made.StatusCode);
            var code = CodeSent();
            Assert.Matches("^[A-Z2-7]{4}-[A-Z2-7]{4}$", code);
            Assert.Equal(UserId, _server.Opened.Last().Body.GetProperty("recipient_id").GetString());
            var listed = await admin.GetStringAsync("/api/notifications/destinations");
            Assert.Contains("\"state\":\"unverified\"", listed);
            Assert.DoesNotContain(UserId, listed);
            Assert.DoesNotContain(code, listed);
            using (var scope = factory.Services.CreateScope())
            {
                var row = await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelLinkCodes.SingleAsync();
                Assert.DoesNotContain(code.Replace("-", "").ToLowerInvariant(), row.CodeHash);
            }

            // A wrong code does not connect it; the right one (typed any way) does, once.
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite("AAAA-AAAA"))).StatusCode);
            Assert.Contains("\"state\":\"unverified\"", await admin.GetStringAsync("/api/notifications/destinations"));

            var typed = " " + code.ToLowerInvariant() + " ";
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite(typed))).StatusCode);
            Assert.Contains("\"state\":\"connected\"", await admin.GetStringAsync("/api/notifications/destinations"));
            Assert.Contains("Connected", _server.Messages.Last().Body.GetProperty("content").GetString());
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(
                "/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite(code))).StatusCode);   // spent

            // And a real notification now arrives in the direct messages.
            var me = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();
            using (var scope = factory.Services.CreateScope())
            {
                var user = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.FirstAsync(u => u.Id == me);
                factory.Services.GetRequiredService<EmailSender>().NotifyInBackground(
                    user, NotificationCatalog.Shared, "@bea shared “Plan” with you", "body");
            }
            await factory.Services.GetRequiredService<ChannelDeliveryService>().ProcessAsync(CancellationToken.None);
            var embed = _server.Messages.Last().Body.GetProperty("embeds")[0];
            Assert.Equal("A note was shared with you", embed.GetProperty("title").GetString());

            // Clearing the bot turns direct messages off again.
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(null, null, ""));
            Assert.False((await admin.GetFromJsonAsync<JsonElement>("/api/notifications/destinations"))
                .GetProperty("discord").GetProperty("dm").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WhenDiscordWontLetTheBotMessageYou_NothingIsConnected_AndTheOldOneStays()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(true, null, BotToken));
            // An earlier webhook connection.
            int me;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                me = (await db.Users.FirstAsync()).Id;
                db.ChannelDestinations.Add(new ChannelDestination
                {
                    UserId = me, Channel = "discord", Kind = "webhook", Label = "Discord · channel", Verified = true, CreatedUtc = DateTime.UtcNow,
                });
                await db.SaveChangesAsync();
            }
            _server.Handler = (_, path) => path.EndsWith("/users/@me/channels", StringComparison.Ordinal)
                ? (403, """{"message":"Cannot send messages to this user","code":50007}""", null)
                : (200, """{"id":"1"}""", null);

            var res = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId));

            Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
            Assert.Contains("allow direct messages", await res.Content.ReadAsStringAsync());
            using var check = factory.Services.CreateScope();
            var db2 = check.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal("webhook", (await db2.ChannelDestinations.SingleAsync()).Kind);   // untouched
            Assert.Empty(await db2.ChannelLinkCodes.ToListAsync());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ACodeThatHasExpired_ConnectsNothing()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(true, null, BotToken));
            await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId));
            var code = CodeSent();
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                (await db.ChannelLinkCodes.SingleAsync()).ExpiresUtc = DateTime.UtcNow.AddMinutes(-1);
                await db.SaveChangesAsync();
            }

            var res = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite(code));

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Contains("expired", await res.Content.ReadAsStringAsync());
            Assert.Contains("\"state\":\"unverified\"", await admin.GetStringAsync("/api/notifications/destinations"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APersonCannotConfirmWithAnotherPersonsCode_OrSettingsTheyMayNotChange()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PutAsJsonAsync("/api/admin/notifications/discord", new DiscordAdminWrite(true, null, BotToken));
            await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId));
            var code = CodeSent();

            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "b@example.com", "hunter2!", "User"));
            var bea = factory.CreateClient();
            await bea.LoginAsync("bea", "hunter2!");
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");

            Assert.Equal(HttpStatusCode.BadRequest, (await bea.PostAsJsonAsync(
                "/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite(code))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PutAsJsonAsync(
                "/api/admin/notifications/discord", new DiscordAdminWrite(null, null, "x"))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsync("/api/admin/notifications/discord/check-bot", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WithDiscordSwitchedOff_NoCodeIsSent()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var res = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm", new DiscordDirectWrite(UserId));

            Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
            Assert.Contains("isn't turned on", await res.Content.ReadAsStringAsync());
            Assert.Empty(_server.Calls);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ACodeThatIsTheWrongLength_IsTurnedAwayWithoutALookup()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var res = await admin.PostAsJsonAsync("/api/notifications/destinations/discord/dm/confirm", new DiscordCodeWrite("short"));

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
