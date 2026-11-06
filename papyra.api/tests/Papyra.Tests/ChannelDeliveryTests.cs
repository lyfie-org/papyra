using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Features;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Tests;

// The chat-notification core: who gets what, when it is retried, when a destination is paused.
// A scripted fake channel stands in for ntfy/Discord/Telegram, and the clock is ours, so every wait
// and every retry is exact.
public sealed class ChannelDeliveryTests : IDisposable
{
    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 11, 10, 9, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    // Answers each send from a script, then "sent". Remembers what it was asked to send.
    private sealed class FakeChannel : INotificationChannel
    {
        public string Id => NotificationCatalog.Ntfy;
        public bool Available = true;
        public Queue<Func<ChannelSendResult>> Script = new();
        public List<(string Handle, ChannelMessage Message)> Sent = [];
        public bool IsAvailable(InstanceConfigStore config) => Available;
        public Task<ChannelSendResult> SendAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct)
        {
            Sent.Add((destination.Handle, message));
            return Task.FromResult(Script.Count > 0 ? Script.Dequeue()() : ChannelSendResult.Ok);
        }
    }

    private readonly SqliteConnection _conn;
    private readonly ServiceProvider _sp;
    private readonly TestClock _clock = new();
    private readonly FakeChannel _channel = new();
    private readonly ChannelDeliveryService _svc;
    private readonly EmailSender _email;

    public ChannelDeliveryTests()
    {
        _conn = new SqliteConnection("DataSource=:memory:");
        _conn.Open();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(_clock);
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
        services.AddDbContext<AppDbContext>(o => o.UseSqlite(_conn));
        services.AddSingleton<SecretBox>();
        services.AddSingleton<InstanceConfigStore>();
        services.AddSingleton<INotificationChannel>(_channel);
        services.AddSingleton<ChannelDeliveryService>();
        services.AddSingleton<EmailSender>();
        _sp = services.BuildServiceProvider();

        using (var scope = _sp.CreateScope())
            scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();

        _svc = _sp.GetRequiredService<ChannelDeliveryService>();
        _email = _sp.GetRequiredService<EmailSender>();
    }

    public void Dispose()
    {
        _sp.Dispose();
        _conn.Dispose();
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private async Task<User> AddUserAsync(string name, string role = "User", bool disabled = false)
    {
        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = new User
        {
            Username = name, Email = name + "@example.com", Role = role,
            DisabledUtc = disabled ? DateTime.UtcNow : null,
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    private async Task<ChannelDestination> AddDestinationAsync(
        User user, bool verified = true, bool enabled = true, string tier = ChannelPrivacy.Minimal,
        DateTime? pausedUtc = null, int failures = 0)
    {
        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var d = new ChannelDestination
        {
            UserId = user.Id, Channel = NotificationCatalog.Ntfy, Handle = "topic-" + user.Username,
            Label = "ntfy · " + user.Username, Verified = verified, Enabled = enabled, PrivacyTier = tier,
            PausedUtc = pausedUtc, ConsecutiveFailures = failures, CreatedUtc = DateTime.UtcNow,
        };
        db.ChannelDestinations.Add(d);
        await db.SaveChangesAsync();
        return d;
    }

    private void Notify(User user, string eventId, string subject = "A subject") =>
        _email.NotifyInBackground(user, eventId, subject, "body");

    private Task ProcessAsync() => _svc.ProcessAsync(CancellationToken.None);

    private async Task<List<ChannelDelivery>> RowsAsync()
    {
        using var scope = _sp.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>()
            .ChannelDeliveries.AsNoTracking().OrderBy(d => d.Id).ToListAsync();
    }

    private async Task<ChannelDestination> ReloadAsync(int id)
    {
        using var scope = _sp.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>()
            .ChannelDestinations.AsNoTracking().FirstAsync(d => d.Id == id);
    }

    // ── who gets what ───────────────────────────────────────────────────────────

    [Fact]
    public async Task AConnectedDestination_GetsAGenericLine_EvenWhenMailIsNotSetUp()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        Assert.False(_email.IsConfigured);

        Notify(ana, NotificationCatalog.Mention, "@bea mentioned you in “Secret plan”");
        await ProcessAsync();

        var (handle, message) = Assert.Single(_channel.Sent);
        Assert.Equal("topic-ana", handle);
        Assert.Equal("You were mentioned in a note", message.Title);
        Assert.DoesNotContain("bea", message.Title);
        Assert.DoesNotContain("Secret", message.Title);

        var row = Assert.Single(await RowsAsync());
        Assert.Equal(ChannelDeliveryStatus.Sent, row.Status);
        Assert.Equal(string.Empty, row.Title); // nothing kept once it is sent
    }

    [Fact]
    public async Task TheTitlesTier_SendsTheSubject()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana, tier: ChannelPrivacy.Titles);

        Notify(ana, NotificationCatalog.Shared, "@bea shared “Trip plan” with you");
        await ProcessAsync();

        Assert.Equal("@bea shared “Trip plan” with you", Assert.Single(_channel.Sent).Message.Title);
    }

    [Fact]
    public async Task AdminSetPublicUrl_BecomesTheLink()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        var config = _sp.GetRequiredService<InstanceConfigStore>();
        await config.SetAsync(new Dictionary<string, string?> { [SmtpKeys.PublicUrl] = "https://notes.example.com/" });

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        Assert.Equal("https://notes.example.com/?notifications=1", Assert.Single(_channel.Sent).Message.Link);
    }

    [Theory]
    [InlineData(NotificationCatalog.NewSignIn)]
    [InlineData(NotificationCatalog.PasswordChanged)]
    [InlineData(NotificationCatalog.AccountDeletion)]
    [InlineData(NotificationCatalog.ChannelPaused)]
    [InlineData(NotificationCatalog.PasswordReset)]
    public async Task AlwaysOnSecurityNotices_StayEmailOnly(string eventId)
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);

        Notify(ana, eventId);
        await ProcessAsync();

        Assert.Empty(_channel.Sent);
        Assert.Empty(await RowsAsync());
    }

    [Fact]
    public async Task NothingIsSentToAnUnverifiedSwitchedOffPausedOrDisabledPerson()
    {
        var unverified = await AddUserAsync("unverified");
        var off = await AddUserAsync("off");
        var paused = await AddUserAsync("paused");
        var disabled = await AddUserAsync("disabled", disabled: true);
        await AddDestinationAsync(unverified, verified: false);
        await AddDestinationAsync(off, enabled: false);
        await AddDestinationAsync(paused, pausedUtc: DateTime.UtcNow);
        await AddDestinationAsync(disabled);

        foreach (var u in new[] { unverified, off, paused, disabled }) Notify(u, NotificationCatalog.Mention);
        await ProcessAsync();

        Assert.Empty(_channel.Sent);
        Assert.Empty(await RowsAsync());
    }

    [Fact]
    public async Task ThePersonsPerEventSwitch_ForThatChannel_Decides()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);

        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = await db.Users.FirstAsync(u => u.Id == ana.Id);
            Assert.True(NotificationPrefs.Set(user, NotificationCatalog.Mention, false, NotificationCatalog.Ntfy));
            await db.SaveChangesAsync();
        }

        Notify(ana, NotificationCatalog.Mention);          // switched off for ntfy
        Notify(ana, NotificationCatalog.BackupSucceeded);  // off by default
        Notify(ana, NotificationCatalog.Shared);           // on by default
        await ProcessAsync();

        Assert.Equal("A note was shared with you", Assert.Single(_channel.Sent).Message.Title);
    }

    [Fact]
    public void TheOldMailSwitches_DoNotDecideForChatChannels()
    {
        var user = new User { Username = "ana", NotifyOnMention = false };

        Assert.False(NotificationPrefs.Wants(user, NotificationCatalog.Mention, NotificationCatalog.Email));
        Assert.True(NotificationPrefs.Wants(user, NotificationCatalog.Mention, NotificationCatalog.Ntfy));
    }

    [Fact]
    public async Task TurningOffMailForAnEvent_LeavesTheChatChannelAlone()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = await db.Users.FirstAsync(u => u.Id == ana.Id);
            NotificationPrefs.Set(user, NotificationCatalog.Comments, false); // email
            await db.SaveChangesAsync();
        }

        Notify(ana, NotificationCatalog.Comments);
        await ProcessAsync();

        Assert.Single(_channel.Sent);
    }

    [Fact]
    public async Task AdminOnlyEvents_NeverReachANonAdmin()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);

        Notify(ana, NotificationCatalog.AdminJobFailed);
        await ProcessAsync();

        Assert.Empty(_channel.Sent);
    }

    [Fact]
    public async Task AChannelTheAdminHasNotSwitchedOn_ReceivesNothing()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        _channel.Available = false;

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        Assert.Empty(_channel.Sent);
        Assert.Empty(await RowsAsync());
    }

    [Fact]
    public async Task AWaitingMessage_IsDropped_IfTheChannelIsSwitchedOffBeforeItIsSent()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => ChannelSendResult.Retry("busy"));
        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();                       // first try fails, one is waiting
        _channel.Available = false;
        _clock.Advance(TimeSpan.FromMinutes(2));

        await ProcessAsync();

        Assert.Single(_channel.Sent);               // not tried again
        Assert.Equal(ChannelDeliveryStatus.Dropped, Assert.Single(await RowsAsync()).Status);
    }

    [Fact]
    public async Task AQueueFullOfWaitingMessages_IsCapped()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        _channel.Available = true;
        // Every try hits a hiccup, so everything stays queued.
        for (var i = 0; i < ChannelDeliveryService.MaxPendingPerDestination + 20; i++)
            _channel.Script.Enqueue(() => ChannelSendResult.Retry("busy"));

        for (var i = 0; i < ChannelDeliveryService.MaxPendingPerDestination + 20; i++)
            Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        Assert.Equal(ChannelDeliveryService.MaxPendingPerDestination, (await RowsAsync()).Count);
    }

    // ── retry, give-up, pause ───────────────────────────────────────────────────

    [Fact]
    public async Task AHiccup_IsRetriedAfterTheBackoff_NotBefore()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => ChannelSendResult.Retry("network"));

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();
        var waiting = Assert.Single(await RowsAsync());
        Assert.Equal(ChannelDeliveryStatus.Pending, waiting.Status);
        Assert.Equal(1, waiting.Attempts);
        Assert.Equal(_clock.GetUtcNow().UtcDateTime.AddMinutes(1), waiting.NextAttemptUtc);

        _clock.Advance(TimeSpan.FromSeconds(30));
        await ProcessAsync();
        Assert.Single(_channel.Sent);               // too early

        _clock.Advance(TimeSpan.FromSeconds(31));
        await ProcessAsync();
        Assert.Equal(2, _channel.Sent.Count);
        var done = Assert.Single(await RowsAsync());
        Assert.Equal(ChannelDeliveryStatus.Sent, done.Status);
        Assert.Equal(2, done.Attempts);
    }

    [Fact]
    public async Task WhatTheServiceAsksFor_WinsOverTheBackoff_WhenLonger()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => ChannelSendResult.Retry("rate limited", TimeSpan.FromMinutes(10)));

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        Assert.Equal(_clock.GetUtcNow().UtcDateTime.AddMinutes(10), Assert.Single(await RowsAsync()).NextAttemptUtc);
    }

    [Fact]
    public async Task ASuccess_ClearsTheFailureCount()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana, failures: 3);

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        var after = await ReloadAsync(dest.Id);
        Assert.Equal(0, after.ConsecutiveFailures);
        Assert.NotNull(after.LastOkUtc);
        Assert.Equal("connected", ChannelEndpoints.State(after));
    }

    [Fact]
    public async Task AMessageThatNeverGoesThrough_IsGivenUp_AndTheFifthGiveUpPausesTheDestination()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana, failures: ChannelDeliveryService.PauseAfterFailures - 1);
        for (var i = 0; i < ChannelDeliveryService.MaxAttempts; i++)
            _channel.Script.Enqueue(() => ChannelSendResult.Retry("network"));

        Notify(ana, NotificationCatalog.Mention);
        var mailBefore = _email.QueuedCount; // the ordinary email for the mention itself
        for (var i = 0; i < ChannelDeliveryService.MaxAttempts; i++)
        {
            await ProcessAsync();
            _clock.Advance(TimeSpan.FromHours(7));
        }

        Assert.Equal(ChannelDeliveryService.MaxAttempts, _channel.Sent.Count);
        var row = Assert.Single(await RowsAsync());
        Assert.Equal(ChannelDeliveryStatus.Failed, row.Status);

        var after = await ReloadAsync(dest.Id);
        Assert.NotNull(after.PausedUtc);
        Assert.Equal("paused", ChannelEndpoints.State(after));
        Assert.Equal(mailBefore + 1, _email.QueuedCount); // the person is told, once, by email
    }

    [Fact]
    public async Task AFlakyServiceThatRecovers_NeverPauses()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana);

        for (var round = 0; round < 8; round++)
        {
            _channel.Script.Enqueue(() => ChannelSendResult.Retry("network"));
            Notify(ana, NotificationCatalog.Mention);
            await ProcessAsync();
            _clock.Advance(TimeSpan.FromMinutes(2));
            await ProcessAsync();                   // the retry succeeds and resets the count
        }

        Assert.Null((await ReloadAsync(dest.Id)).PausedUtc);
    }

    [Fact]
    public async Task ARefusalThatWillNotHeal_PausesAtOnce_DropsTheRest_AndTellsThePersonByEmail()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => ChannelSendResult.Retry("busy"));   // first message stays queued
        _channel.Script.Enqueue(() => ChannelSendResult.Rejected("The webhook was deleted."));
        Notify(ana, NotificationCatalog.Mention);
        Notify(ana, NotificationCatalog.Shared);
        var mailBefore = _email.QueuedCount; // the ordinary emails for the two notices

        await ProcessAsync();

        var rows = await RowsAsync();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, r => Assert.NotEqual(ChannelDeliveryStatus.Pending, r.Status));
        Assert.Contains(rows, r => r.Status == ChannelDeliveryStatus.Failed);
        Assert.Contains(rows, r => r.Status == ChannelDeliveryStatus.Dropped);

        var after = await ReloadAsync(dest.Id);
        Assert.NotNull(after.PausedUtc);
        Assert.Equal("The webhook was deleted.", after.LastError);
        Assert.Equal(mailBefore + 1, _email.QueuedCount);

        // And nothing more is sent while it is paused.
        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();
        Assert.Equal(2, _channel.Sent.Count);
    }

    [Fact]
    public async Task ADestinationRemovedWhileAMessageWaits_DropsTheMessage()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => ChannelSendResult.Retry("busy"));
        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.ChannelDestinations.Remove(await db.ChannelDestinations.FirstAsync(d => d.Id == dest.Id));
            await db.SaveChangesAsync();
        }
        _clock.Advance(TimeSpan.FromMinutes(2));
        await ProcessAsync();

        Assert.Single(_channel.Sent);
        Assert.Equal(ChannelDeliveryStatus.Dropped, Assert.Single(await RowsAsync()).Status);
    }

    [Fact]
    public async Task AProviderThatThrows_IsRetried_WithoutLeakingItsMessage()
    {
        var ana = await AddUserAsync("ana");
        var dest = await AddDestinationAsync(ana);
        _channel.Script.Enqueue(() => throw new InvalidOperationException("POST https://discord.com/api/webhooks/1/SECRET failed"));

        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();

        var row = Assert.Single(await RowsAsync());
        Assert.Equal(ChannelDeliveryStatus.Pending, row.Status);
        Assert.DoesNotContain("SECRET", row.LastError);
        Assert.DoesNotContain("SECRET", (await ReloadAsync(dest.Id)).LastError);
    }

    [Fact]
    public async Task FinishedRows_AreTidiedAWeekLater()
    {
        var ana = await AddUserAsync("ana");
        await AddDestinationAsync(ana);
        Notify(ana, NotificationCatalog.Mention);
        await ProcessAsync();
        Assert.Single(await RowsAsync());

        _clock.Advance(TimeSpan.FromDays(8));
        await ProcessAsync();

        Assert.Empty(await RowsAsync());
    }

    // ── the person's own destinations, through the real app ─────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-chan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
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
    public async Task TheDestinationsEndpoints_ListSwitchAndRemove_OnlyMyOwn_AndNeverShowASecret()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            var me = (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();

            int mine, theirs;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var other = new User { Username = "other", Email = "o@example.com" };
                db.Users.Add(other);
                await db.SaveChangesAsync();
                var box = scope.ServiceProvider.GetRequiredService<SecretBox>();
                var a = new ChannelDestination
                {
                    UserId = me, Channel = NotificationCatalog.Ntfy, Handle = "plain-handle", Label = "ntfy · mine",
                    SecretSealed = box.Seal("https://ntfy.example/very-secret-topic"), Verified = true,
                    PausedUtc = DateTime.UtcNow, LastError = "The topic was refused.", LastErrorUtc = DateTime.UtcNow,
                    CreatedUtc = DateTime.UtcNow,
                };
                var b = new ChannelDestination
                {
                    UserId = other.Id, Channel = NotificationCatalog.Ntfy, Label = "ntfy · theirs", Verified = true,
                    CreatedUtc = DateTime.UtcNow,
                };
                db.ChannelDestinations.AddRange(a, b);
                db.ChannelDeliveries.Add(new ChannelDelivery
                {
                    DestinationId = a.Id, UserId = me, Channel = a.Channel, EventId = NotificationCatalog.Mention,
                    Title = "x", CreatedUtc = DateTime.UtcNow, NextAttemptUtc = DateTime.UtcNow,
                });
                await db.SaveChangesAsync();
                (mine, theirs) = (a.Id, b.Id);
            }

            var raw = await client.GetStringAsync("/api/notifications/destinations");
            Assert.DoesNotContain("very-secret-topic", raw);
            Assert.DoesNotContain("plain-handle", raw);
            Assert.DoesNotContain("theirs", raw);
            var list = JsonDocument.Parse(raw).RootElement.GetProperty("destinations");
            var item = Assert.Single(list.EnumerateArray());
            Assert.Equal("paused", item.GetProperty("state").GetString());
            Assert.Equal("minimal", item.GetProperty("privacyTier").GetString());

            Assert.Equal(HttpStatusCode.NotFound, (await client.PatchAsJsonAsync(
                $"/api/notifications/destinations/{theirs}", new ChannelDestinationUpdate(true, null))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync($"/api/notifications/destinations/{theirs}")).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync(
                $"/api/notifications/destinations/{mine}", new ChannelDestinationUpdate(null, "everything"))).StatusCode);

            // Turning it on is also how a paused destination is tried again.
            Assert.Equal(HttpStatusCode.NoContent, (await client.PatchAsJsonAsync(
                $"/api/notifications/destinations/{mine}", new ChannelDestinationUpdate(true, "titles"))).StatusCode);
            var again = (await client.GetFromJsonAsync<JsonElement>("/api/notifications/destinations"))
                .GetProperty("destinations")[0];
            Assert.Equal("attention", again.GetProperty("state").GetString());
            Assert.Equal("titles", again.GetProperty("privacyTier").GetString());

            Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/notifications/destinations/{mine}")).StatusCode);
            using var check = factory.Services.CreateScope();
            var after = check.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.False(await after.ChannelDestinations.AnyAsync(d => d.Id == mine));
            Assert.False(await after.ChannelDeliveries.AnyAsync(d => d.DestinationId == mine));
            Assert.True(await after.ChannelDestinations.AnyAsync(d => d.Id == theirs));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheNotificationSettings_StillShowEmail_AndAddTheChatSwitches()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostSetupAsync(new SetupRequest("admin", "Admin", "admin@example.com", "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

            var settings = await client.GetFromJsonAsync<JsonElement>("/api/auth/notifications");
            Assert.Empty(settings.GetProperty("available").EnumerateArray());
            var mention = settings.GetProperty("events").EnumerateArray()
                .First(e => e.GetProperty("id").GetString() == NotificationCatalog.Mention);
            Assert.True(mention.GetProperty("email").GetBoolean());
            Assert.True(mention.GetProperty("chat").GetProperty("ntfy").GetBoolean());
            var critical = settings.GetProperty("events").EnumerateArray()
                .First(e => e.GetProperty("id").GetString() == NotificationCatalog.NewSignIn);
            Assert.Empty(critical.GetProperty("chat").EnumerateObject());

            // A chat channel's switch can be saved like the email one.
            var save = await client.PutAsJsonAsync("/api/auth/notifications", new
            {
                events = new[] { new { id = NotificationCatalog.Mention, enabled = false, channel = "ntfy" } },
            });
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);
            var after = await client.GetFromJsonAsync<JsonElement>("/api/auth/notifications");
            var m = after.GetProperty("events").EnumerateArray()
                .First(e => e.GetProperty("id").GetString() == NotificationCatalog.Mention);
            Assert.False(m.GetProperty("chat").GetProperty("ntfy").GetBoolean());
            Assert.True(m.GetProperty("email").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }
}
