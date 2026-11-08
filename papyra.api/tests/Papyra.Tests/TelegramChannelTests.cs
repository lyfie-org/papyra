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
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Features;
using Papyra.Api.Models;
using Papyra.Api.Security;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Tests;

// Telegram: the API calls against a fake Telegram, the provider, the link-up flow (a one-time code in a link,
// /start, /stop) and set-up end to end.
public sealed class TelegramChannelTests : IAsyncLifetime
{
    private const string Token = "123456:SECRET-bot-token";

    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 11, 10, 9, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    // A stand-in for api.telegram.org on this machine.
    private sealed class FakeTelegram : IAsyncDisposable
    {
        public sealed record Call(string Token, string Method, JsonElement Body);

        public List<Call> Calls { get; } = [];
        public Func<string, JsonElement, (int Status, string Json)> Handler = (_, _) => (200, """{"ok":true,"result":true}""");
        private WebApplication? _app;

        public string Url { get; private set; } = string.Empty;

        public IEnumerable<Call> Sent => Calls.Where(c => c.Method == "sendMessage");

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
                // /bot<token>/<method>
                var path = ctx.Request.Path.Value ?? "";
                var slash = path.LastIndexOf('/');
                var method = path[(slash + 1)..];
                var token = path["/bot".Length..slash];
                var body = doc.RootElement.Clone();
                Calls.Add(new Call(token, method, body));
                var (status, json) = Handler(method, body);
                ctx.Response.StatusCode = status;
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

    private readonly FakeTelegram _server = new();
    private readonly TestClock _clock = new();
    private SqliteConnection _conn = null!;
    private ServiceProvider _sp = null!;
    private TelegramApi _api = null!;
    private TelegramLinker _linker = null!;

    public async Task InitializeAsync()
    {
        await _server.StartAsync();
        _conn = new SqliteConnection("DataSource=:memory:");
        _conn.Open();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(_clock);
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
        services.AddDbContext<AppDbContext>(o => o.UseSqlite(_conn));
        services.AddSingleton<SecretBox>();
        services.AddSingleton<InstanceConfigStore>();
        _sp = services.BuildServiceProvider();
        using (var scope = _sp.CreateScope())
            scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();

        _api = new TelegramApi(new OutboundPolicy(Config, allowLoopback: true)) { BaseUrl = _server.Url };
        _linker = new TelegramLinker(
            _sp.GetRequiredService<IServiceScopeFactory>(), Config, _api, _clock, NullLogger<TelegramLinker>.Instance);
    }

    public async Task DisposeAsync()
    {
        await _sp.DisposeAsync();
        _conn.Dispose();
        await _server.DisposeAsync();
    }

    private InstanceConfigStore Config => _sp.GetRequiredService<InstanceConfigStore>();

    private Task ConfigureAsync(bool enabled = true, string bot = "PapyraBot") =>
        Config.SetAsync(new Dictionary<string, string?>
        {
            [ChannelKeys.Enabled(NotificationCatalog.Telegram)] = enabled ? "true" : "false",
            [ChannelKeys.TelegramBotToken] = Token,
            [ChannelKeys.TelegramBotUsername] = bot,
        });

    private async Task<User> AddUserAsync(string name, bool disabled = false)
    {
        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = new User { Username = name, Email = name + "@example.com", DisabledUtc = disabled ? DateTime.UtcNow : null };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    private async Task<List<ChannelDestination>> DestinationsAsync()
    {
        using var scope = _sp.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelDestinations.AsNoTracking().ToListAsync();
    }

    private static string UpdatesJson(params string[] updates) => $$"""{"ok":true,"result":[{{string.Join(",", updates)}}]}""";

    private static string Msg(long updateId, long chatId, string text, string type = "private", string? username = "rahul", string first = "Rahul")
    {
        var chat = new Dictionary<string, object?> { ["id"] = chatId, ["type"] = type, ["first_name"] = first };
        if (username is not null) chat["username"] = username;
        return JsonSerializer.Serialize(new { update_id = updateId, message = new { message_id = 1, chat, text } });
    }

    // The fake answers the next getUpdates with these, then nothing.
    private void BotReceives(params string[] updates)
    {
        var queue = new Queue<string>(updates);
        _server.Handler = (method, _) =>
            method == "getUpdates" ? (200, queue.Count > 0 ? UpdatesJson(queue.Dequeue()) : UpdatesJson()) : (200, """{"ok":true,"result":true}""");
    }

    private static string CodeFrom(TelegramLink link) => link.Code;

    // ── The API calls ───────────────────────────────────────────────────────────

    [Fact]
    public async Task GetMe_NamesTheBot()
    {
        _server.Handler = (_, _) => (200, """{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Papyra notes","username":"PapyraBot"}}""");

        var (bot, error) = await _api.GetMeAsync(Token, default);

        Assert.Null(error);
        Assert.Equal("PapyraBot", bot!.Username);
        Assert.Equal(Token, _server.Calls.Single().Token);
    }

    [Fact]
    public async Task GetMe_WithAWrongToken_SaysSoPlainly()
    {
        _server.Handler = (_, _) => (401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""");

        var (bot, error) = await _api.GetMeAsync(Token, default);

        Assert.Null(bot);
        Assert.Contains("BotFather", error);
    }

    [Fact]
    public async Task APapyraThatCannotReachTelegram_NeverPutsTheTokenInItsWords()
    {
        var offline = new TelegramApi(new OutboundPolicy(Config, allowLoopback: true)) { BaseUrl = "http://127.0.0.1:1" };

        var (_, error) = await offline.GetMeAsync(Token, default);
        var send = await offline.SendMessageAsync(Token, "42", "hi", default);

        Assert.DoesNotContain("SECRET", error);
        Assert.DoesNotContain("SECRET", send.Error);
        Assert.Equal(ChannelOutcome.Retry, send.Outcome);
    }

    [Fact]
    public async Task SendMessage_PostsPlainTextToTheChat()
    {
        var result = await _api.SendMessageAsync(Token, "424242", "You were mentioned in a note", default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        var call = Assert.Single(_server.Sent);
        Assert.Equal(424242, call.Body.GetProperty("chat_id").GetInt64());
        Assert.Equal("You were mentioned in a note", call.Body.GetProperty("text").GetString());
        Assert.True(call.Body.GetProperty("disable_web_page_preview").GetBoolean());
        Assert.False(call.Body.TryGetProperty("parse_mode", out _)); // nothing in a title can become formatting
    }

    [Theory]
    [InlineData(403, """{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}""", ChannelOutcome.Rejected, "blocked")]
    [InlineData(400, """{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}""", ChannelOutcome.Rejected, "find that chat")]
    [InlineData(400, """{"ok":false,"error_code":400,"description":"Bad Request: something else"}""", ChannelOutcome.Rejected, "400")]
    [InlineData(401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""", ChannelOutcome.Retry, "administrator")]
    [InlineData(500, """{"ok":false,"error_code":500,"description":"Internal Server Error"}""", ChannelOutcome.Retry, "500")]
    [InlineData(502, "<html>Bad gateway</html>", ChannelOutcome.Retry, "unexpected")]
    public async Task EachAnswer_IsEitherWorthRetryingOrFinal(int status, string json, ChannelOutcome expected, string saysSo)
    {
        _server.Handler = (_, _) => (status, json);

        var result = await _api.SendMessageAsync(Token, "42", "hi", default);

        Assert.Equal(expected, result.Outcome);
        Assert.Contains(saysSo, result.Error);
    }

    [Fact]
    public async Task ARateLimit_IsRetriedAfterWhatTelegramAsked()
    {
        _server.Handler = (_, _) => (429, """{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}""");

        var result = await _api.SendMessageAsync(Token, "42", "hi", default);

        Assert.Equal(ChannelOutcome.Retry, result.Outcome);
        Assert.Equal(TimeSpan.FromSeconds(7), result.RetryAfter);
    }

    [Fact]
    public async Task GetUpdates_ReadsTheMessagesAndAsksFromTheOffset()
    {
        BotReceives(Msg(10, 555, "/start abc"));

        var result = await _api.GetUpdatesAsync(Token, 10, 0, default);

        Assert.Null(result.Error);
        var update = Assert.Single(result.Updates);
        Assert.Equal((10L, 555L, "private", "/start abc", "rahul"), (update.UpdateId, update.ChatId, update.ChatType, update.Text, update.Username));
        var call = Assert.Single(_server.Calls);
        Assert.Equal(10, call.Body.GetProperty("offset").GetInt64());
        Assert.Equal("message", call.Body.GetProperty("allowed_updates")[0].GetString());
    }

    [Fact]
    public async Task GetUpdates_ExplainsABadTokenAndASecondReader()
    {
        _server.Handler = (_, _) => (401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""");
        var bad = await _api.GetUpdatesAsync(Token, 0, 0, default);
        Assert.True(bad.BadToken);

        _server.Handler = (_, _) => (409, """{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}""");
        var conflict = await _api.GetUpdatesAsync(Token, 0, 0, default);
        Assert.False(conflict.BadToken);
        Assert.Contains("already reading", conflict.Error);
    }

    // ── The provider ────────────────────────────────────────────────────────────

    [Fact]
    public async Task TheChannel_IsAvailableOnlyWhenOnWithATokenAndABotName()
    {
        var channel = new TelegramChannel(Config, _api);
        await Config.EnsureLoadedAsync();
        Assert.False(channel.IsAvailable(Config));

        await ConfigureAsync(enabled: false);
        Assert.False(channel.IsAvailable(Config));

        await ConfigureAsync();
        Assert.True(channel.IsAvailable(Config));
        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.TelegramBotUsername] = "" });
        Assert.False(channel.IsAvailable(Config));
    }

    [Fact]
    public async Task TheChannel_SendsTheLineAndTheLinkToTheChat()
    {
        await ConfigureAsync();
        var channel = new TelegramChannel(Config, _api);
        var chat = new ChannelDestination { Channel = NotificationCatalog.Telegram, Kind = TelegramChannel.ChatKind, Handle = "777" };

        var result = await channel.SendAsync(chat, new ChannelMessage(NotificationCatalog.Mention, "You were mentioned in a note", "https://notes.example.com/?notifications=1"), default);

        Assert.Equal(ChannelOutcome.Sent, result.Outcome);
        var call = Assert.Single(_server.Sent);
        Assert.Equal(Token, call.Token);
        Assert.Equal("You were mentioned in a note\nhttps://notes.example.com/?notifications=1", call.Body.GetProperty("text").GetString());
        Assert.False(channel.CanBeConfirmedByPerson(chat));
    }

    [Fact]
    public async Task ADestinationThatIsNotAChat_IsRefused_AndNothingIsSent()
    {
        await ConfigureAsync();
        var channel = new TelegramChannel(Config, _api);

        var result = await channel.SendAsync(new ChannelDestination { Channel = NotificationCatalog.Telegram }, new ChannelMessage("x", "hi", null), default);

        Assert.Equal(ChannelOutcome.Rejected, result.Outcome);
        Assert.Empty(_server.Calls);
    }

    // ── Making a link ───────────────────────────────────────────────────────────

    [Fact]
    public async Task ALink_CarriesAOneTimeCode_ThatIsStoredOnlyAsAHash()
    {
        await ConfigureAsync(bot: "PapyraBot");
        var ana = await AddUserAsync("ana");

        var link = (await _linker.NewLinkAsync(ana.Id, default))!;

        Assert.Equal(20, link.Code.Length);
        Assert.Matches("^[a-z2-7]{20}$", link.Code);
        Assert.Equal($"https://t.me/PapyraBot?start={link.Code}", link.Url);
        Assert.Equal(_clock.GetUtcNow().UtcDateTime.AddMinutes(10), link.ExpiresUtc);

        using var scope = _sp.CreateScope();
        var row = await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelLinkCodes.SingleAsync();
        Assert.Equal(ana.Id, row.UserId);
        Assert.DoesNotContain(link.Code, row.CodeHash);
        Assert.Equal(64, row.CodeHash.Length);
    }

    [Fact]
    public async Task NoLinkIsMade_UntilTelegramIsSetUp()
    {
        var ana = await AddUserAsync("ana");
        Assert.Null(await _linker.NewLinkAsync(ana.Id, default));

        await ConfigureAsync(enabled: false);
        Assert.Null(await _linker.NewLinkAsync(ana.Id, default));
    }

    // ── Connecting by tapping the link ──────────────────────────────────────────

    [Fact]
    public async Task PressingStartOnYourLink_ConnectsThatChatToYourAccount()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var link = (await _linker.NewLinkAsync(ana.Id, default))!;
        BotReceives(Msg(100, 555, $"/start {link.Code}", username: "rahul"));

        Assert.Equal(PollResult.Ok, await _linker.PollOnceAsync(default));

        var dest = Assert.Single(await DestinationsAsync());
        Assert.Equal((ana.Id, "telegram", "chat", "555", "Telegram · @rahul", true, true),
            (dest.UserId, dest.Channel, dest.Kind, dest.Handle, dest.Label, dest.Verified, dest.Enabled));

        // The bot answers in that chat, naming the account, and the code is spent.
        var reply = Assert.Single(_server.Sent);
        Assert.Equal(555, reply.Body.GetProperty("chat_id").GetInt64());
        Assert.Contains("“ana”", reply.Body.GetProperty("text").GetString());
        Assert.Contains("/stop", reply.Body.GetProperty("text").GetString());
        using var scope = _sp.CreateScope();
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelLinkCodes.ToListAsync());
    }

    [Fact]
    public async Task TheBotsNameInTheCommand_DoesNotMatter()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var link = (await _linker.NewLinkAsync(ana.Id, default))!;
        BotReceives(Msg(1, 9, $"/start@PapyraBot {link.Code}"));

        await _linker.PollOnceAsync(default);

        Assert.Single(await DestinationsAsync());
    }

    [Fact]
    public async Task ACodeWorksOnce()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var link = (await _linker.NewLinkAsync(ana.Id, default))!;
        BotReceives(Msg(1, 111, $"/start {link.Code}"), Msg(2, 222, $"/start {link.Code}"));

        await _linker.PollOnceAsync(default);
        await _linker.PollOnceAsync(default);

        var dest = Assert.Single(await DestinationsAsync());
        Assert.Equal("111", dest.Handle);                                    // the second chat got nothing
        Assert.Contains("expired", _server.Sent.Last().Body.GetProperty("text").GetString());
        Assert.Equal(222, _server.Sent.Last().Body.GetProperty("chat_id").GetInt64());
    }

    [Fact]
    public async Task AnExpiredCode_ConnectsNothing_AndIsRemoved()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var link = (await _linker.NewLinkAsync(ana.Id, default))!;
        _clock.Advance(TimeSpan.FromMinutes(11));
        BotReceives(Msg(1, 111, $"/start {link.Code}"));

        await _linker.PollOnceAsync(default);

        Assert.Empty(await DestinationsAsync());
        Assert.Contains("expired", _server.Sent.Single().Body.GetProperty("text").GetString());
        using var scope = _sp.CreateScope();
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<AppDbContext>().ChannelLinkCodes.ToListAsync());
    }

    [Fact]
    public async Task AMadeUpCode_ConnectsNothing()
    {
        await ConfigureAsync();
        await AddUserAsync("ana");
        BotReceives(Msg(1, 111, "/start aaaaaaaaaaaaaaaaaaaa"));

        await _linker.PollOnceAsync(default);

        Assert.Empty(await DestinationsAsync());
        Assert.Contains("expired", _server.Sent.Single().Body.GetProperty("text").GetString());
    }

    [Fact]
    public async Task ADisabledAccountsCode_ConnectsNothing()
    {
        await ConfigureAsync();
        var gone = await AddUserAsync("gone");
        var link = (await _linker.NewLinkAsync(gone.Id, default))!;
        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            (await db.Users.FirstAsync(u => u.Id == gone.Id)).DisabledUtc = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        BotReceives(Msg(1, 111, $"/start {link.Code}"));

        await _linker.PollOnceAsync(default);

        Assert.Empty(await DestinationsAsync());
    }

    [Fact]
    public async Task ANewLink_StopsTheOldOneWorking()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var first = (await _linker.NewLinkAsync(ana.Id, default))!;
        var second = (await _linker.NewLinkAsync(ana.Id, default))!;
        BotReceives(Msg(1, 111, $"/start {first.Code}"), Msg(2, 222, $"/start {second.Code}"));

        await _linker.PollOnceAsync(default);
        await _linker.PollOnceAsync(default);

        Assert.Equal("222", Assert.Single(await DestinationsAsync()).Handle);
    }

    [Fact]
    public async Task ConnectingAgain_ReplacesTheChat_AndItsQueuedMessages()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        int oldId;
        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var old = new ChannelDestination
            {
                UserId = ana.Id, Channel = NotificationCatalog.Telegram, Kind = "chat", Handle = "111", Verified = true, CreatedUtc = DateTime.UtcNow,
            };
            db.ChannelDestinations.Add(old);
            await db.SaveChangesAsync();
            db.ChannelDeliveries.Add(new ChannelDelivery
            {
                DestinationId = old.Id, UserId = ana.Id, Channel = "telegram", EventId = "collab.mention", Title = "x",
                CreatedUtc = DateTime.UtcNow, NextAttemptUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
            oldId = old.Id;
        }
        var link = (await _linker.NewLinkAsync(ana.Id, default))!;
        BotReceives(Msg(1, 333, $"/start {link.Code}"));

        await _linker.PollOnceAsync(default);

        var dest = Assert.Single(await DestinationsAsync());
        Assert.Equal("333", dest.Handle);
        using var check = _sp.CreateScope();
        Assert.False(await check.ServiceProvider.GetRequiredService<AppDbContext>().ChannelDeliveries.AnyAsync(d => d.DestinationId == oldId));
    }

    [Fact]
    public async Task StopDisconnectsThatChat_AndOnlyThat()
    {
        await ConfigureAsync();
        var ana = await AddUserAsync("ana");
        var bea = await AddUserAsync("bea");
        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.ChannelDestinations.AddRange(
                new ChannelDestination { UserId = ana.Id, Channel = "telegram", Kind = "chat", Handle = "111", Verified = true, CreatedUtc = DateTime.UtcNow },
                new ChannelDestination { UserId = bea.Id, Channel = "telegram", Kind = "chat", Handle = "222", Verified = true, CreatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        }
        BotReceives(Msg(1, 111, "/stop"), Msg(2, 999, "/stop"));

        await _linker.PollOnceAsync(default);
        await _linker.PollOnceAsync(default);

        Assert.Equal("222", Assert.Single(await DestinationsAsync()).Handle);
        Assert.Contains("Disconnected", _server.Sent.First().Body.GetProperty("text").GetString());
        Assert.Contains("isn't connected", _server.Sent.Last().Body.GetProperty("text").GetString());
    }

    [Fact]
    public async Task ABareStart_ExplainsHowToConnect_AndEverythingElseIsIgnored()
    {
        await ConfigureAsync();
        BotReceives(
            Msg(1, 111, "/start"),
            Msg(2, 111, "hello there"),
            Msg(3, 111, "/help"),
            Msg(4, -100200, "/start abc", type: "group"),
            Msg(5, -100200, "/stop", type: "supergroup"));

        for (var i = 0; i < 5; i++) await _linker.PollOnceAsync(default);

        var reply = Assert.Single(_server.Sent); // only the bare /start was answered
        Assert.Contains("Settings", reply.Body.GetProperty("text").GetString());
        Assert.Empty(await DestinationsAsync());
    }

    [Fact]
    public async Task PapyraRemembersHowFarItRead_AndAsksFromThere()
    {
        await ConfigureAsync();
        BotReceives(Msg(40, 1, "hi"), Msg(41, 1, "hi"));

        await _linker.PollOnceAsync(default);
        await _linker.PollOnceAsync(default);

        var polls = _server.Calls.Where(c => c.Method == "getUpdates").ToList();
        Assert.Equal(0, polls[0].Body.GetProperty("offset").GetInt64());
        Assert.Equal(41, polls[1].Body.GetProperty("offset").GetInt64());
        Assert.Equal("42", Config.Get(ChannelKeys.TelegramOffset));
    }

    [Fact]
    public async Task ReadingFails_Quietly_AndIsReportedToTheAdmin()
    {
        await ConfigureAsync();
        _server.Handler = (_, _) => (409, """{"ok":false,"error_code":409,"description":"Conflict"}""");
        Assert.Equal(PollResult.Error, await _linker.PollOnceAsync(default));
        Assert.Contains("already reading", _linker.LastError);

        _server.Handler = (_, _) => (401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""");
        Assert.Equal(PollResult.BadToken, await _linker.PollOnceAsync(default));

        BotReceives();
        Assert.Equal(PollResult.Ok, await _linker.PollOnceAsync(default));
        Assert.Null(_linker.LastError);

        await ConfigureAsync(enabled: false);
        Assert.Equal(PollResult.Idle, await _linker.PollOnceAsync(default));
    }

    // ── Settings given in the environment ──────────────────────────────────────

    private static IConfiguration Env(params (string Key, string Value)[] pairs) =>
        new ConfigurationBuilder().AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => (string?)p.Value)).Build();

    private Task SeedAsync(IConfiguration env, bool allowLoopback = false) =>
        ChannelSeed.SeedAsync(env, Config, new OutboundPolicy(Config, allowLoopback), _api, NullLogger.Instance, default);

    [Fact]
    public void TheFriendlyEnvironmentNames_FeedTheSeed()
    {
        var resolved = EnvAliases.Resolve(new Dictionary<string, string?>
        {
            ["PAPYRA_NTFY_URL"] = "https://ntfy.example.com",
            ["PAPYRA_NTFY_TOKEN"] = "tk_x",
            ["PAPYRA_TELEGRAM_BOT_TOKEN"] = "123:abc",
        });
        Assert.Equal("https://ntfy.example.com", resolved["Channels:Ntfy:Url"]);
        Assert.Equal("tk_x", resolved["Channels:Ntfy:Token"]);
        Assert.Equal("123:abc", resolved["Channels:Telegram:BotToken"]);
    }

    [Fact]
    public async Task NtfyFromTheEnvironment_IsImportedOnce_AndSwitchedOn()
    {
        await SeedAsync(Env(("Channels:Ntfy:Url", "https://8.8.8.8/"), ("Channels:Ntfy:Token", "tk_env")));

        Assert.True(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Ntfy)));
        Assert.Equal("https://8.8.8.8", Config.Get(ChannelKeys.NtfyServer));
        Assert.Equal("tk_env", Config.Get(ChannelKeys.NtfyToken));
        using var scope = _sp.CreateScope();
        var raw = (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Settings.FirstAsync(s => s.Key == ChannelKeys.NtfyToken)).Value;
        Assert.StartsWith(SecretBox.Prefix, raw);          // sealed like any token typed in the app
    }

    [Fact]
    public async Task OnceTheAdminHasChosen_TheEnvironmentIsIgnored()
    {
        await Config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.Enabled(NotificationCatalog.Ntfy)] = "false" });

        await SeedAsync(Env(("Channels:Ntfy:Url", "https://8.8.8.8"), ("Channels:Ntfy:Token", "tk_env")));

        Assert.False(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Ntfy)));
        Assert.False(Config.Has(ChannelKeys.NtfyServer));
        Assert.False(Config.Has(ChannelKeys.NtfyToken));
    }

    [Theory]
    [InlineData("https://10.1.2.3")]          // on the home network: must be allowed first
    [InlineData("https://127.0.0.1")]         // never reachable
    [InlineData("http://8.8.8.8")]            // plain http to a public host
    [InlineData("not a url")]
    public async Task AnNtfyAddressThatDoesNotCheckOut_IsSkippedWhole(string url)
    {
        await SeedAsync(Env(("Channels:Ntfy:Url", url), ("Channels:Ntfy:Token", "tk_env")));

        Assert.False(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Ntfy)));
        Assert.False(Config.Has(ChannelKeys.NtfyToken));   // never half-applied
    }

    [Fact]
    public async Task AnAddressOnTheAllowedList_IsAccepted()
    {
        await Config.SetAsync(new Dictionary<string, string?> { [OutboundPolicy.AllowedHostsKey] = "10.1.2.3" });

        await SeedAsync(Env(("Channels:Ntfy:Url", "http://10.1.2.3:2586")));

        Assert.True(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Ntfy)));
        Assert.Equal("http://10.1.2.3:2586", Config.Get(ChannelKeys.NtfyServer));
    }

    [Fact]
    public async Task AGoodTelegramBotToken_IsCheckedWithTelegram_ThenKeptWithTheBotsName()
    {
        _server.Handler = (_, _) => (200, """{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Papyra","username":"PapyraBot"}}""");

        await SeedAsync(Env(("Channels:Telegram:BotToken", Token)));

        Assert.True(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Telegram)));
        Assert.Equal(Token, Config.Get(ChannelKeys.TelegramBotToken));
        Assert.Equal("PapyraBot", Config.Get(ChannelKeys.TelegramBotUsername));
        using var scope = _sp.CreateScope();
        var raw = (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Settings.FirstAsync(s => s.Key == ChannelKeys.TelegramBotToken)).Value;
        Assert.DoesNotContain("SECRET", raw);
    }

    [Fact]
    public async Task ATelegramBotTokenTelegramRefuses_IsNotKept()
    {
        _server.Handler = (_, _) => (401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""");

        await SeedAsync(Env(("Channels:Telegram:BotToken", Token)));

        Assert.False(Config.Has(ChannelKeys.TelegramBotToken));
        Assert.False(Config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Telegram)));
    }

    [Fact]
    public async Task NothingInTheEnvironment_ChangesNothing()
    {
        await SeedAsync(Env());

        Assert.Empty(_server.Calls);
        Assert.False(Config.Has(ChannelKeys.NtfyServer));
    }

    // ── Set-up, end to end ──────────────────────────────────────────────────────

    private (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-tg-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<OutboundPolicy>();
                s.AddSingleton(sp => new OutboundPolicy(sp.GetRequiredService<InstanceConfigStore>(), allowLoopback: true));
                s.RemoveAll<TelegramApi>();
                s.AddSingleton(sp => new TelegramApi(sp.GetRequiredService<OutboundPolicy>()) { BaseUrl = _server.Url });
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
    public async Task TheAdminSetsTelegramUp_ThenAPersonConnects_AndIsNotified()
    {
        var (factory, dir) = NewApp();
        try
        {
            _server.Handler = (method, _) => method == "getMe"
                ? (200, """{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Papyra","username":"PapyraBot"}}""")
                : (200, """{"ok":true,"result":true}""");
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));

            // Off until the admin sets it up; no link can be made meanwhile.
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsync("/api/notifications/destinations/telegram/link", null)).StatusCode);

            // A wrong token is caught at once, with Telegram's own verdict.
            _server.Handler = (_, _) => (401, """{"ok":false,"error_code":401,"description":"Unauthorized"}""");
            var wrong = await admin.PutAsJsonAsync("/api/admin/notifications/telegram", new TelegramAdminWrite(true, "wrong"));
            Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
            Assert.Contains("BotFather", await wrong.Content.ReadAsStringAsync());

            _server.Handler = (method, _) => method == "getMe"
                ? (200, """{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Papyra","username":"PapyraBot"}}""")
                : (200, """{"ok":true,"result":true}""");
            var save = await admin.PutAsJsonAsync("/api/admin/notifications/telegram", new TelegramAdminWrite(true, Token));
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);
            Assert.Equal("PapyraBot", (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("botUsername").GetString());

            var settings = await admin.GetStringAsync("/api/admin/notifications");
            Assert.DoesNotContain("SECRET", settings);
            var telegram = JsonDocument.Parse(settings).RootElement.GetProperty("telegram");
            Assert.True(telegram.GetProperty("enabled").GetBoolean());
            Assert.True(telegram.GetProperty("hasToken").GetBoolean());
            using (var scope = factory.Services.CreateScope())
            {
                var raw = (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Settings
                    .FirstAsync(s => s.Key == ChannelKeys.TelegramBotToken)).Value;
                Assert.StartsWith(SecretBox.Prefix, raw);
                Assert.DoesNotContain("SECRET", raw);
            }
            Assert.True((await (await admin.PostAsync("/api/admin/notifications/telegram/check", null)).Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("ok").GetBoolean());

            // The person asks for a link, "taps" it (the bot receives /start <code>), and is connected.
            var link = await (await admin.PostAsync("/api/notifications/destinations/telegram/link", null)).Content.ReadFromJsonAsync<JsonElement>();
            var url = link.GetProperty("url").GetString()!;
            Assert.StartsWith("https://t.me/PapyraBot?start=", url);
            var code = url[(url.IndexOf("start=", StringComparison.Ordinal) + 6)..];
            BotReceives(Msg(5, 4242, $"/start {code}", username: "rahul"));
            var linker = factory.Services.GetRequiredService<TelegramLinker>();
            Assert.Equal(PollResult.Ok, await linker.PollOnceAsync(default));

            var listed = await admin.GetStringAsync("/api/notifications/destinations");
            Assert.Contains("\"state\":\"connected\"", listed);
            Assert.DoesNotContain("4242", listed); // the chat id stays server-side
            var id = JsonDocument.Parse(listed).RootElement.GetProperty("destinations")[0].GetProperty("id").GetInt32();

            // The generic test works, and a real notification arrives as the generic line.
            var test = await (await admin.PostAsync($"/api/notifications/destinations/{id}/test", null)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(test.GetProperty("ok").GetBoolean());
            var me = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();
            using (var scope = factory.Services.CreateScope())
            {
                var user = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.FirstAsync(u => u.Id == me);
                factory.Services.GetRequiredService<EmailSender>().NotifyInBackground(
                    user, NotificationCatalog.Comments, "@bea commented on your note “Plan”", "body");
            }
            await factory.Services.GetRequiredService<ChannelDeliveryService>().ProcessAsync(CancellationToken.None);
            var last = _server.Sent.Last();
            Assert.Equal(4242, last.Body.GetProperty("chat_id").GetInt64());
            Assert.Equal("There is a new comment for you", last.Body.GetProperty("text").GetString());

            // The person blocks the bot: the next send is refused for good and the destination pauses.
            _server.Handler = (method, _) => method == "sendMessage"
                ? (403, """{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}""")
                : (200, """{"ok":true,"result":true}""");
            using (var scope = factory.Services.CreateScope())
            {
                var user = await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.FirstAsync(u => u.Id == me);
                factory.Services.GetRequiredService<EmailSender>().NotifyInBackground(
                    user, NotificationCatalog.Shared, "@bea shared a note", "body");
            }
            await factory.Services.GetRequiredService<ChannelDeliveryService>().ProcessAsync(CancellationToken.None);
            Assert.Contains("\"state\":\"paused\"", await admin.GetStringAsync("/api/notifications/destinations"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APersonWhoIsNotAnAdmin_CannotChangeTelegramSettings()
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
                "/api/admin/notifications/telegram", new TelegramAdminWrite(true, Token))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.PostAsync("/api/admin/notifications/telegram/check", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ClearingTheToken_TurnsTheBotsNameOffToo()
    {
        var (factory, dir) = NewApp();
        try
        {
            _server.Handler = (method, _) => method == "getMe"
                ? (200, """{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Papyra","username":"PapyraBot"}}""")
                : (200, """{"ok":true,"result":true}""");
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            await admin.PutAsJsonAsync("/api/admin/notifications/telegram", new TelegramAdminWrite(true, Token));

            await admin.PutAsJsonAsync("/api/admin/notifications/telegram", new TelegramAdminWrite(null, ""));

            var telegram = (await admin.GetFromJsonAsync<JsonElement>("/api/admin/notifications")).GetProperty("telegram");
            Assert.False(telegram.GetProperty("hasToken").GetBoolean());
            Assert.Equal("", telegram.GetProperty("botUsername").GetString());
            Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsync("/api/notifications/destinations/telegram/link", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
