using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using static Papyra.Tests.JournalEndpointsTests;

namespace Papyra.Tests;

/// <summary>The journal's on/off switch: off hides it from every route, job and search, and deletes nothing.</summary>
public sealed class JournalOffTests
{
    private static Task<HttpResponseMessage> Switch(HttpClient c, bool on) =>
        c.PutAsJsonAsync("/api/journal/settings", new { enabled = on });

    private static async Task AssertOff(HttpResponseMessage res, string what)
    {
        Assert.True(res.StatusCode == HttpStatusCode.NotFound, $"{what} → {(int)res.StatusCode}");
        Assert.Equal("journal_off", (await Json(res)).GetProperty("code").GetString());
    }

    [Fact]
    public Task TheJournalIsOnByDefault() => WithAppAsync(async app =>
    {
        var s = await app.Client.GetFromJsonAsync<JsonElement>("/api/journal/settings");
        Assert.True(s.GetProperty("settings").GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await app.Client.GetAsync("/api/journal/today")).StatusCode);
    });

    [Fact]
    public void AMissingOrGarbageSettingsFile_ReadsAsOn()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-joff-" + Guid.NewGuid().ToString("N"));
        try
        {
            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dir }).Build();
            var settings = new JournalSettings(config, new StubHostEnvironment(dir));

            Assert.True(settings.IsEnabled("1"));

            // An older file that has never heard of the switch.
            var file = JournalSettings.FileFor(config, dir, "1");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, "{\"dayStartsAt\":2,\"reminderOn\":true}");
            Assert.True(settings.IsEnabled("1"));
            Assert.Equal(2, settings.Read("1").DayStartsAt);

            File.WriteAllText(file, "not json at all");
            Assert.True(settings.IsEnabled("1"));
        }
        finally { try { Directory.Delete(dir, recursive: true); } catch (IOException) { } }
    }

    [Fact]
    public Task Off_EveryJournalRouteAnswers404_ButSettingsStillWork() => WithAppAsync(async app =>
    {
        Assert.Equal(HttpStatusCode.OK, (await Switch(app.Client, false)).StatusCode);
        var s = await app.Client.GetFromJsonAsync<JsonElement>("/api/journal/settings");
        Assert.False(s.GetProperty("settings").GetProperty("enabled").GetBoolean());

        foreach (var (method, url) in new[]
        {
            ("GET", "/api/journal/today"), ("GET", $"/api/journal?from={app.Day(3)}&to={app.Today}"),
            ("GET", "/api/journal/stats"), ("GET", $"/api/journal/on-this-day?date={app.Today}"),
            ("GET", "/api/journal/templates"), ("GET", "/api/journal/bin?state=locked"),
            ("GET", $"/api/journal/{app.Today}"), ("POST", "/api/journal/lock-all"),
            ("POST", $"/api/journal/{app.Today}/carry-over"),
        })
        {
            await AssertOff(await app.Client.SendAsync(new HttpRequestMessage(new HttpMethod(method), url)), $"{method} {url}");
        }
        await AssertOff(await PutDay(app.Client, app.Today, new { body = "should not land" }), "PUT day");
        await AssertOff(await app.Client.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "nor this" }), "append");
        Assert.False(File.Exists(app.FileFor(app.Today)));

        // The other settings keep working while it's off.
        Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync("/api/journal/settings", new { promptsOn = false })).StatusCode);
        Assert.False((await app.Client.GetFromJsonAsync<JsonElement>("/api/journal/settings"))
            .GetProperty("settings").GetProperty("enabled").GetBoolean());
    });

    [Fact]
    public Task TurningItBackOn_RestoresEverything_ByteForByte() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "a quiet day\n\n- [ ] call mum", mood = 4 });
        await PutDay(app.Client, app.Day(1), new { body = "yesterday", secure = false });
        var before = await File.ReadAllBytesAsync(app.FileFor(app.Today));
        var beforeYesterday = await File.ReadAllBytesAsync(app.FileFor(app.Day(1)));

        await Switch(app.Client, false);
        Assert.Equal(before, await File.ReadAllBytesAsync(app.FileFor(app.Today)));
        Assert.Equal(beforeYesterday, await File.ReadAllBytesAsync(app.FileFor(app.Day(1))));

        await Switch(app.Client, true);
        var day = await app.Client.GetFromJsonAsync<JsonElement>($"/api/journal/{app.Today}");
        Assert.Contains("call mum", day.GetProperty("body").GetString());
        Assert.Equal(before, await File.ReadAllBytesAsync(app.FileFor(app.Today)));
        Assert.Equal(beforeYesterday, await File.ReadAllBytesAsync(app.FileFor(app.Day(1))));
    });

    [Fact]
    public Task Off_AJournalKeyIsRefused_AndWorksAgainWhenOn() => WithAppAsync(async app =>
    {
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        Assert.Equal(HttpStatusCode.OK, (await PutDay(key, app.Today, new { body = "from a script" })).StatusCode);

        await Switch(app.Client, false);
        await AssertOff(await key.GetAsync("/api/journal/today"), "key GET today");
        await AssertOff(await PutDay(key, app.Today, new { body = "an agent must not write here" }), "key PUT");
        await AssertOff(await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "nor append" }), "key append");
        Assert.DoesNotContain("must not write", await File.ReadAllTextAsync(app.FileFor(app.Today)));

        await Switch(app.Client, true);
        Assert.Equal(HttpStatusCode.OK, (await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "back on" })).StatusCode);
    });

    [Fact]
    public Task Off_TheJournalExportIsStillReachable() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "keep my data reachable" });
        await Switch(app.Client, false);

        var summary = await app.Client.GetAsync("/api/export/journal/summary");
        Assert.Equal(HttpStatusCode.OK, summary.StatusCode);
        Assert.Equal(1, (await Json(summary)).GetProperty("days").GetInt32());
    });

    [Fact]
    public Task Off_SearchAndBacklinksLeaveTheJournalOut() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/trip", new NoteWrite("Kyoto", null, null, false, false, "temples to see"));
        await PutDay(app.Client, app.Today, new { body = "Walked to the quokka sanctuary, then planned [[Kyoto]]." });

        async Task<string[]> SearchIds(string q) =>
            (await app.Client.GetFromJsonAsync<JsonElement>($"/api/search?q={q}")).EnumerateArray()
                .Select(h => h.GetProperty("id").GetString()!).ToArray();
        async Task<string[]> BacklinkIds() =>
            (await app.Client.GetFromJsonAsync<JsonElement>("/api/notes/trip/backlinks")).EnumerateArray()
                .Select(h => h.GetProperty("noteId").GetString()!).ToArray();

        // The index is updated in the background: wait for the day to be findable.
        var id = $"journal-{app.Today}";
        for (var i = 0; i < 100 && !(await SearchIds("quokka")).Contains(id); i++) await Task.Delay(100);
        Assert.Contains(id, await SearchIds("quokka"));
        Assert.Contains(id, await BacklinkIds());

        await Switch(app.Client, false);
        Assert.DoesNotContain(id, await SearchIds("quokka"));
        Assert.DoesNotContain(id, await BacklinkIds());

        // Nothing was re-indexed or removed: switching back on finds it straight away.
        await Switch(app.Client, true);
        Assert.Contains(id, await SearchIds("quokka"));
        Assert.Contains(id, await BacklinkIds());
    });

    [Fact]
    public void TheReminder_IsOnlyWanted_WhenTheJournalIsOnAndAReminderWasAsked()
    {
        Assert.True(JournalReminderJob.Wanted(new JournalPrefs { ReminderOn = true }));
        Assert.False(JournalReminderJob.Wanted(new JournalPrefs { ReminderOn = true, Enabled = false }));
        Assert.False(JournalReminderJob.Wanted(new JournalPrefs { ReminderOn = false }));
    }

    private sealed class StubHostEnvironment(string root) : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "Papyra.Tests";
        public string ContentRootPath { get; set; } = root;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }
}
