using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>The journal's HTTP surface: lazy entries, dated files, the desk staying clean, guards, locks and keys.</summary>
public sealed class JournalEndpointsTests
{
    private const string Pw = "hunter2!";

    internal sealed record App(WebApplicationFactory<Program> Factory, HttpClient Client, string Dir, string Uid, string Today)
    {
        public string Notes => Path.Combine(Dir, "users", Uid, "notes");
        public string Day(int daysAgo) => DateOnly.Parse(Today).AddDays(-daysAgo).ToString("yyyy-MM-dd");
        public string FileFor(string date) => Path.Combine(Notes, "journal", date[..4], date.Substring(5, 2), date + ".md");
    }

    internal static async Task WithAppAsync(Func<App, Task> test, string? timeZone = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-journal-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostSetupAsync(new SetupRequest("admin", "Admin", "a@b.c", Pw, Pin: TestAuth.VaultPin, TimeZone: timeZone));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            var uid = (await setup.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32().ToString();
            var today = (await client.GetFromJsonAsync<JsonElement>("/api/journal/today")).GetProperty("date").GetString()!;
            await test(new App(factory, client, dir, uid, today));
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    internal static async Task<JsonElement> Json(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    internal static Task<HttpResponseMessage> PutDay(HttpClient c, string date, object body, string? ifMatch = null, string? unlock = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, $"/api/journal/{date}") { Content = JsonContent.Create(body) };
        if (ifMatch is not null) req.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        if (unlock is not null) req.Headers.Add("X-Unlock-Token", unlock);
        return c.SendAsync(req);
    }

    internal static async Task<string> NewKeyAsync(App app, string scope)
    {
        var res = await app.Client.PostAsJsonAsync("/api/keys", new ApiKeyWrite("script", await TestAuth.CodeAsync(app.Client), scope));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await Json(res)).GetProperty("token").GetString()!;
    }

    internal static HttpClient KeyClient(App app, string token)
    {
        var c = app.Factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-API-Key", token);
        return c;
    }

    // ── Lazy entries and dated files ─────────────────────────────────────────────

    [Fact]
    public Task Today_IsDecidedByTheServer_AndCreatesNothing() => WithAppAsync(async app =>
    {
        var res = await app.Client.GetAsync("/api/journal/today");
        var json = await Json(res);
        Assert.Equal(app.Today, json.GetProperty("date").GetString());
        Assert.False(json.GetProperty("entry").GetProperty("exists").GetBoolean());
        Assert.Equal(0, json.GetProperty("stats").GetProperty("current").GetInt32());
        Assert.False(Directory.Exists(Path.Combine(app.Notes, "journal")));

        // An empty write — what an editor autosaves the moment a page opens — writes nothing.
        var empty = await PutDay(app.Client, app.Today, new { body = "" });
        Assert.Equal(HttpStatusCode.OK, empty.StatusCode);
        Assert.False((await Json(empty)).GetProperty("exists").GetBoolean());
        Assert.False(File.Exists(app.FileFor(app.Today)));
        var blank = await PutDay(app.Client, app.Today, new { body = "  \n " });
        Assert.False((await Json(blank)).GetProperty("exists").GetBoolean());
        Assert.False(File.Exists(app.FileFor(app.Today)));
    });

    [Fact]
    public Task TheFirstRealWrite_CreatesTheDatedFile() => WithAppAsync(async app =>
    {
        var res = await PutDay(app.Client, app.Today, new { body = "Walked home in the rain.", mood = 4, tags = new[] { "grateful" } });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = await Json(res);
        Assert.True(json.GetProperty("exists").GetBoolean());
        Assert.Equal(4, json.GetProperty("mood").GetInt32());
        Assert.Equal(5, json.GetProperty("words").GetInt32());
        Assert.NotNull(res.Headers.ETag);

        var file = app.FileFor(app.Today);
        Assert.True(File.Exists(file), file);
        var text = await File.ReadAllTextAsync(file);
        Assert.Contains($"id: journal-{app.Today}", text);
        Assert.Contains("kind: journal", text);
        Assert.Contains("mood: 4", text);
        Assert.Contains("Walked home in the rain.", text);

        var back = await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"));
        Assert.Equal("Walked home in the rain.", back.GetProperty("body").GetString());
        Assert.Equal("grateful", back.GetProperty("tags")[0].GetString());
    });

    [Fact]
    public Task AMoodAlone_IsAnEntry() => WithAppAsync(async app =>
    {
        var res = await PutDay(app.Client, app.Today, new { mood = 2 });
        Assert.True((await Json(res)).GetProperty("exists").GetBoolean());
        Assert.True(File.Exists(app.FileFor(app.Today)));
        var stats = await Json(await app.Client.GetAsync("/api/journal/stats"));
        Assert.Equal(1, stats.GetProperty("current").GetInt32());
    });

    [Fact]
    public Task Mood_IsValidated_ClearedWithNull_KeptWhenAbsent() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "x", mood = 3 });
        foreach (var bad in new[] { "0", "6", "\"4\"", "2.5", "-1", "true" })
        {
            var req = new HttpRequestMessage(HttpMethod.Put, $"/api/journal/{app.Today}")
            {
                Content = new StringContent($"{{\"mood\":{bad}}}", System.Text.Encoding.UTF8, "application/json"),
            };
            Assert.Equal((HttpStatusCode)422, (await app.Client.SendAsync(req)).StatusCode);
        }
        // Absent keeps it.
        Assert.Equal(3, (await Json(await PutDay(app.Client, app.Today, new { body = "x and y" }))).GetProperty("mood").GetInt32());
        // Null clears it.
        var cleared = new HttpRequestMessage(HttpMethod.Put, $"/api/journal/{app.Today}")
        {
            Content = new StringContent("{\"mood\":null}", System.Text.Encoding.UTF8, "application/json"),
        };
        var json = await Json(await app.Client.SendAsync(cleared));
        Assert.Equal(JsonValueKind.Null, json.GetProperty("mood").ValueKind);
        Assert.DoesNotContain("mood:", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task Dates_AreValidated_AndTheFutureIsRefused() => WithAppAsync(async app =>
    {
        foreach (var bad in new[] { "abc", "2026-13-01", "2026-1-5", "2026-02-30", "20261025", "2026-10-25x" })
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await app.Client.GetAsync($"/api/journal/{bad}")).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await PutDay(app.Client, bad, new { body = "x" })).StatusCode);
        }
        Assert.Contains((await app.Client.GetAsync("/api/journal/..%2F..%2Fx")).StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.BadRequest });
        Assert.False(Directory.Exists(Path.Combine(app.Notes, "journal")));

        var tomorrow = DateOnly.Parse(app.Today).AddDays(1).ToString("yyyy-MM-dd");
        var future = await PutDay(app.Client, tomorrow, new { body = "tomorrow" });
        Assert.Equal((HttpStatusCode)422, future.StatusCode);
        Assert.Equal("future_date", (await Json(future)).GetProperty("code").GetString());
        var peek = await Json(await app.Client.GetAsync($"/api/journal/{tomorrow}"));
        Assert.False(peek.GetProperty("exists").GetBoolean());
        Assert.True(peek.GetProperty("future").GetBoolean());
        Assert.False(Directory.Exists(Path.Combine(app.Notes, "journal")));

        // The past is open — a day long before there was a journal.
        Assert.Equal(HttpStatusCode.OK, (await PutDay(app.Client, "2020-02-29", new { body = "a leap day" })).StatusCode);
        Assert.True(File.Exists(app.FileFor("2020-02-29")));
    });

    // ── Conflicts ────────────────────────────────────────────────────────────────

    [Fact]
    public Task AStaleWrite_Gets412_AndAMatchingOneLands() => WithAppAsync(async app =>
    {
        var first = await PutDay(app.Client, app.Today, new { body = "one" });
        var etag1 = first.Headers.ETag!.Tag;
        var second = await PutDay(app.Client, app.Today, new { body = "one two" }, ifMatch: etag1);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        // A second device still holds the first version.
        var stale = await PutDay(app.Client, app.Today, new { body = "one three" }, ifMatch: etag1);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        var json = await Json(stale);
        Assert.Equal("stale", json.GetProperty("code").GetString());
        Assert.Equal("one two", json.GetProperty("body").GetString());
        Assert.Equal("one two", (await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"))).GetProperty("body").GetString());

        // A metadata-only change (a mood tap) needs no fresh body.
        Assert.Equal(HttpStatusCode.OK, (await PutDay(app.Client, app.Today, new { mood = 5 }, ifMatch: etag1)).StatusCode);
    });

    [Fact]
    public Task EveryWrite_LeavesAVersionInHistory() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "first draft" });
        await PutDay(app.Client, app.Today, new { body = "second draft that differs" });
        var versions = await app.Client.GetFromJsonAsync<JsonElement>($"/api/notes/journal-{app.Today}/snapshots");
        Assert.True(versions.GetArrayLength() >= 1);
    });

    // ── The desk stays clean ─────────────────────────────────────────────────────

    [Fact]
    public Task Journal_IsNotOnTheDesk_ButIsSearchable() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Groceries", null, null, false, false, "milk and eggs"));
        for (var i = 0; i < 5; i++) await PutDay(app.Client, app.Day(i), new { body = $"zanzibar day {i}" });

        var notes = await app.Client.GetFromJsonAsync<List<Note>>("/api/notes");
        Assert.Equal("n1", Assert.Single(notes!).Id);

        var activity = await app.Client.GetStringAsync("/api/notes/activity");
        Assert.DoesNotContain("journal", activity);

        var found = await app.Client.GetFromJsonAsync<JsonElement>("/api/search?q=zanzibar");
        Assert.Equal(5, found.GetArrayLength());
        Assert.All(found.EnumerateArray(), h => Assert.Equal("journal", h.GetProperty("kind").GetString()));

        // Tags on entries don't pollute the tag list's counts for notes.
        await PutDay(app.Client, app.Today, new { tags = new[] { "diaryonly" } });
        var tags = await app.Client.GetFromJsonAsync<JsonElement>("/api/categories");
        Assert.DoesNotContain("diaryonly", tags.ToString());
    });

    [Fact]
    public Task TheNotesList_DoesNotGrowWithTheJournal() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Groceries", null, null, false, false, "milk"));
        var before = (await app.Client.GetStringAsync("/api/notes")).Length;
        for (var i = 0; i < 60; i++) await PutDay(app.Client, app.Day(i), new { body = new string('w', 400) + " " + i });
        var after = (await app.Client.GetStringAsync("/api/notes")).Length;
        Assert.Equal(before, after);
    });

    // ── Guards on the generic routes ─────────────────────────────────────────────

    [Fact]
    public Task TheGenericRoutes_RefuseAJournalEntry() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "private" });
        var id = $"journal-{app.Today}";

        var put = await app.Client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite("Hijack", null, null, false, false, "overwritten", Kind: "journal"));
        Assert.Equal(HttpStatusCode.Conflict, put.StatusCode);
        Assert.Equal("journal_entry", (await Json(put)).GetProperty("code").GetString());
        Assert.Contains("private", await File.ReadAllTextAsync(app.FileFor(app.Today)));

        // …and nobody can mint an entry through it either.
        var fresh = await app.Client.PutAsJsonAsync("/api/notes/journal-2020-01-01", new NoteWrite("x", null, null, false, false, "x"));
        Assert.Equal(HttpStatusCode.Conflict, fresh.StatusCode);

        // A journal is not shared.
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", Pw, Role: "User"));
        var share = await app.Client.PostAsJsonAsync($"/api/notes/{id}/shares", new ShareWrite("user", "view", "bea", null, null));
        Assert.Equal(HttpStatusCode.Conflict, share.StatusCode);
        var link = await app.Client.PostAsJsonAsync($"/api/notes/{id}/shares", new ShareWrite("link", "view", null, null, null));
        Assert.Equal(HttpStatusCode.Conflict, link.StatusCode);
        var bulkShare = await Json(await app.Client.PostAsJsonAsync("/api/shares/bulk", new BulkShareWrite([id], "bea", "view")));
        Assert.Equal("journalEntry", bulkShare.GetProperty("results")[0].GetProperty("status").GetString());

        // No bulk flags, no live room, no section PATCH.
        var bulk = await Json(await app.Client.PostAsJsonAsync("/api/notes/bulk", new BulkNoteAction([id], "pin")));
        Assert.Equal("journalEntry", bulk.GetProperty("results")[0].GetProperty("status").GetString());
        var ticket = await app.Client.PostAsJsonAsync("/api/collab/ticket", new { noteId = id });
        Assert.Equal(HttpStatusCode.Conflict, ticket.StatusCode);
        var patch = await app.Client.PatchAsJsonAsync($"/api/notes/{id}/sections", new SectionPatch([new SectionOp("append", null, null, null, "x")]));
        Assert.Equal(HttpStatusCode.Conflict, patch.StatusCode);
        Assert.DoesNotContain("overwritten", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task TrashRestoreAndHistory_WorkOffTheDesk() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "keep me" });
        var id = $"journal-{app.Today}";
        Assert.Equal(HttpStatusCode.NoContent, (await app.Client.PostAsync($"/api/notes/{id}/trash", null)).StatusCode);

        var gone = await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"));
        Assert.True(gone.GetProperty("trashed").GetBoolean());
        var write = await PutDay(app.Client, app.Today, new { body = "while in the bin" });
        Assert.Equal(HttpStatusCode.Conflict, write.StatusCode);
        Assert.Equal("trashed", (await Json(write)).GetProperty("code").GetString());
        // A trashed day doesn't hold the streak up.
        Assert.Equal(0, (await Json(await app.Client.GetAsync("/api/journal/stats"))).GetProperty("current").GetInt32());

        Assert.Equal(HttpStatusCode.NoContent, (await app.Client.PostAsync($"/api/notes/{id}/untrash", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutDay(app.Client, app.Today, new { body = "keep me, edited" })).StatusCode);
        Assert.Equal(1, (await Json(await app.Client.GetAsync("/api/journal/stats"))).GetProperty("current").GetInt32());
    });

    // ── Streak and ranges ────────────────────────────────────────────────────────

    [Fact]
    public Task StatsAndRanges_ReadTheWrittenDays() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Day(2), new { body = "two days ago" });
        await PutDay(app.Client, app.Day(1), new { body = "yesterday", mood = 5 });

        // Today unwritten: the streak is alive through yesterday.
        var stats = await Json(await app.Client.GetAsync("/api/journal/stats"));
        Assert.Equal(2, stats.GetProperty("current").GetInt32());
        Assert.False(stats.GetProperty("todayWritten").GetBoolean());

        await PutDay(app.Client, app.Today, new { body = "today" });
        stats = await Json(await app.Client.GetAsync("/api/journal/stats"));
        Assert.Equal(3, stats.GetProperty("current").GetInt32());
        Assert.Equal(3, stats.GetProperty("totalDays").GetInt32());

        var list = await Json(await app.Client.GetAsync($"/api/journal?from={app.Day(5)}&to={app.Today}"));
        var entries = list.GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(3, entries.Count);
        Assert.Equal(app.Day(2), entries[0].GetProperty("date").GetString());
        Assert.Equal(5, entries[1].GetProperty("mood").GetInt32());

        Assert.Equal(HttpStatusCode.BadRequest, (await app.Client.GetAsync("/api/journal?from=nope")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Client.GetAsync($"/api/journal?from={app.Today}&to={app.Day(3)}")).StatusCode);
        Assert.Equal((HttpStatusCode)422, (await app.Client.GetAsync("/api/journal?from=2000-01-01&to=2026-01-01")).StatusCode);
    });

    [Fact]
    public Task OnThisDay_ListsEarlierYears() => WithAppAsync(async app =>
    {
        var t = DateOnly.Parse(app.Today);
        // 29 February can't be "today" in the target year, so pick a plain date a year and two years back.
        var lastYear = new DateOnly(t.Year - 1, t.Month, Math.Min(t.Day, DateTime.DaysInMonth(t.Year - 1, t.Month)));
        await PutDay(app.Client, lastYear.ToString("yyyy-MM-dd"), new { body = "a year ago today" });
        var json = await Json(await app.Client.GetAsync($"/api/journal/on-this-day?date={app.Today}"));
        if (lastYear.Day == t.Day) Assert.Equal("a year ago today", json.GetProperty("entries")[0].GetProperty("excerpt").GetString());
    });

    // ── Append ───────────────────────────────────────────────────────────────────

    [Fact]
    public Task Append_AddsToTheEndOrUnderAHeading() => WithAppAsync(async app =>
    {
        async Task<JsonElement> Append(object body) => await Json(await app.Client.PostAsJsonAsync($"/api/journal/{app.Today}/append", body));

        Assert.Equal("Standup notes", (await Append(new { text = "Standup notes" })).GetProperty("body").GetString());
        Assert.Equal("Standup notes\n\nSecond thought", (await Append(new { text = "Second thought" })).GetProperty("body").GetString());
        var withHeading = (await Append(new { text = "bought a plant", heading = "Log" })).GetProperty("body").GetString();
        Assert.Contains("## Log\n\nbought a plant", withHeading);
        var again = (await Append(new { text = "watered it", heading = "Log" })).GetProperty("body").GetString();
        Assert.Contains("bought a plant", again);
        Assert.Contains("watered it", again);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(again!, "## Log"));

        Assert.Equal((HttpStatusCode)422, (await app.Client.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "  " })).StatusCode);
        var tomorrow = DateOnly.Parse(app.Today).AddDays(1).ToString("yyyy-MM-dd");
        Assert.Equal((HttpStatusCode)422, (await app.Client.PostAsJsonAsync($"/api/journal/{tomorrow}/append", new { text = "x" })).StatusCode);
    });

    [Fact]
    public Task ConcurrentAppends_AreAllKept() => WithAppAsync(async app =>
    {
        var tasks = Enumerable.Range(0, 12)
            .Select(i => app.Client.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = $"line-{i}" }));
        foreach (var res in await Task.WhenAll(tasks)) Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"))).GetProperty("body").GetString()!;
        for (var i = 0; i < 12; i++) Assert.Contains($"line-{i}", body);
    });

    // ── Settings ─────────────────────────────────────────────────────────────────

    [Fact]
    public Task Settings_RoundTrip_AndAreValidated() => WithAppAsync(async app =>
    {
        var res = await app.Client.PutAsJsonAsync("/api/journal/settings", new JournalPrefsWriteDto(DayStartsAt: 3, PromptsOn: false));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var s = (await Json(await app.Client.GetAsync("/api/journal/settings"))).GetProperty("settings");
        Assert.Equal(3, s.GetProperty("dayStartsAt").GetInt32());
        Assert.False(s.GetProperty("promptsOn").GetBoolean());
        Assert.False(s.GetProperty("hideStreak").GetBoolean()); // streak shows by default
        Assert.True(File.Exists(Path.Combine(app.Dir, "users", app.Uid, ".papyra", "journal.json")));

        Assert.Equal((HttpStatusCode)422, (await app.Client.PutAsJsonAsync("/api/journal/settings", new JournalPrefsWriteDto(DayStartsAt: 9))).StatusCode);
        Assert.Equal((HttpStatusCode)422, (await app.Client.PutAsJsonAsync("/api/journal/settings", new JournalPrefsWriteDto(ReminderTime: "9pm"))).StatusCode);
    });

    private sealed record JournalPrefsWriteDto(
        int? DayStartsAt = null, bool? LockNewEntries = null, bool? PromptsOn = null, bool? HideStreak = null,
        bool? ReminderOn = null, string? ReminderTime = null);

    // ── Tenancy ──────────────────────────────────────────────────────────────────

    [Fact]
    public Task TwoTenants_CanHoldTheSameDate() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "admin's day" });
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", Pw, Role: "User"));
        var bea = app.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await bea.LoginAsync("bea", Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

        Assert.False((await Json(await bea.GetAsync($"/api/journal/{app.Today}"))).GetProperty("exists").GetBoolean());
        await PutDay(bea, app.Today, new { body = "bea's day" });
        Assert.Equal("admin's day", (await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"))).GetProperty("body").GetString());
        Assert.Equal("bea's day", (await Json(await bea.GetAsync($"/api/journal/{app.Today}"))).GetProperty("body").GetString());
        Assert.Equal(1, (await Json(await bea.GetAsync("/api/journal/stats"))).GetProperty("totalDays").GetInt32());
    });

    // ── No mentions ──────────────────────────────────────────────────────────────

    [Fact]
    public Task AMention_InTheJournal_DeliversNothing() => WithAppAsync(async app =>
    {
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", Pw, Role: "User"));

        async Task<(int Grants, int Notifications)> BeaCounts()
        {
            using var scope = app.Factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var bea = await db.Users.SingleAsync(u => u.Username == "bea");
            return (await db.BlockGrants.CountAsync(g => g.GranteeUserId == bea.Id),
                    await db.Notifications.CountAsync(n => n.UserId == bea.Id));
        }

        // Control: the same words in an ordinary note do reach her.
        await app.Client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Plans", null, null, false, false, "dinner with @bea tonight"));
        var delivered = false;
        for (var i = 0; i < 100 && !delivered; i++)
        {
            delivered = (await BeaCounts()).Grants == 1;
            if (!delivered) await Task.Delay(100);
        }
        Assert.True(delivered, "the control mention was never delivered");

        // A journal entry (write, edit, append) mentions her three times over: nothing more.
        await PutDay(app.Client, app.Today, new { body = "Thinking about @bea and what she said." });
        await PutDay(app.Client, app.Today, new { body = "Thinking about @bea and what she said. Also @bea again, new line.\n\n@bea" });
        await app.Client.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "Told @bea everything." });
        await Task.Delay(1500);
        Assert.Equal((1, 1), await BeaCounts());

        // The text stays literal.
        var body = (await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"))).GetProperty("body").GetString();
        Assert.Contains("@bea", body);
        Assert.False(File.Exists(Path.Combine(app.Dir, "users", app.Uid, "notes", "Inbox.md")));
    });
}

/// <summary>Linking: backlinks across notes, to-dos and days, and carrying unticked items forward.</summary>
public sealed class JournalLinkingTests
{
    [Fact]
    public Task CarryOver_CopiesOnlyWhatIsStillOpen_AndOnlyOnce() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        var older = app.Day(3);
        await JournalEndpointsTests.PutDay(app.Client, older, new { body = "Plans\n\n- [ ] call mum\n- [x] book flights\n- [ ] buy milk" });
        await JournalEndpointsTests.PutDay(app.Client, app.Day(2), new { body = "A day with nothing to carry" });
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = "Morning pages\n\n- [ ] call mum" });

        var res = await app.Client.PostAsync($"/api/journal/{app.Today}/carry-over", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("1", res.Headers.GetValues("X-Papyra-Carried").Single());
        var body = (await JournalEndpointsTests.Json(res)).GetProperty("body").GetString()!;
        Assert.Contains("- [ ] buy milk", body);
        Assert.DoesNotContain("book flights", body);          // ticked items stay behind
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(body, "call mum")); // already there: not doubled

        // Idempotent.
        var again = await app.Client.PostAsync($"/api/journal/{app.Today}/carry-over", null);
        Assert.Equal("0", again.Headers.GetValues("X-Papyra-Carried").Single());
        Assert.Equal(body, (await JournalEndpointsTests.Json(again)).GetProperty("body").GetString());

        // The day it came from is untouched.
        Assert.Contains("- [ ] buy milk", await File.ReadAllTextAsync(app.FileFor(older)));
        Assert.Contains("- [ ] call mum", await File.ReadAllTextAsync(app.FileFor(older)));
    });

    [Fact]
    public Task CarryOver_WithNothingOpen_WritesNothing() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        var res = await app.Client.PostAsync($"/api/journal/{app.Today}/carry-over", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("0", res.Headers.GetValues("X-Papyra-Carried").Single());
        Assert.False(File.Exists(app.FileFor(app.Today)));
    });

    [Fact]
    public Task CarryOver_NeverReadsALockedDay() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await JournalEndpointsTests.PutDay(app.Client, app.Day(1), new { body = "- [ ] a locked task", secure = true });
        var res = await app.Client.PostAsync($"/api/journal/{app.Today}/carry-over", null);
        Assert.Equal("0", res.Headers.GetValues("X-Papyra-Carried").Single());
        Assert.False(File.Exists(app.FileFor(app.Today)));
    });

    [Fact]
    public Task Backlinks_NameWhereAReferenceLives_NotesTodosAndDays() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/trip", new NoteWrite("Kyoto", null, null, false, false, "temples"));
        await app.Client.PutAsJsonAsync("/api/notes/chores", new NoteWrite("Chores", null, null, false, false, "- [ ] book [[Kyoto]] hotel", Kind: "todo"));
        await JournalEndpointsTests.PutDay(app.Client, app.Day(1), new { body = "Dreaming about [[Kyoto]] again." });
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = $"Yesterday was [[{app.Day(1)}]]." });

        var kyoto = await app.Client.GetFromJsonAsync<JsonElement>("/api/notes/trip/backlinks");
        var kinds = kyoto.EnumerateArray().ToDictionary(b => b.GetProperty("noteId").GetString()!, b => b.GetProperty("kind").GetString());
        Assert.Equal("todo", kinds["chores"]);
        Assert.Equal("journal", kinds[$"journal-{app.Day(1)}"]);

        // …and a day knows who linked to it.
        var day = await app.Client.GetFromJsonAsync<JsonElement>($"/api/notes/journal-{app.Day(1)}/backlinks");
        Assert.Equal($"journal-{app.Today}", Assert.Single(day.EnumerateArray()).GetProperty("noteId").GetString());
    });

    [Fact]
    public Task ALockedEntry_NeverAppearsInBacklinks() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/trip", new NoteWrite("Kyoto", null, null, false, false, "temples"));
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = "secret about [[Kyoto]]", secure = true });
        var kyoto = await app.Client.GetStringAsync("/api/notes/trip/backlinks");
        Assert.DoesNotContain(app.Today, kyoto);
        Assert.DoesNotContain("secret", kyoto);
    });

    [Fact]
    public Task MarginNotes_WorkOnADay_AndMentionNoOne() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", "hunter2!", Role: "User"));
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = "A line worth a margin note." });
        var id = $"journal-{app.Today}";

        var made = await app.Client.PostAsJsonAsync($"/api/comments?note={id}",
            new { body = "Remember this, @bea", quote = new { exact = "worth a margin note", prefix = "A line ", suffix = "." } });
        Assert.Equal(HttpStatusCode.OK, made.StatusCode);
        var threads = (await app.Client.GetFromJsonAsync<JsonElement>($"/api/comments?note={id}")).GetProperty("threads");
        Assert.Equal("worth a margin note", Assert.Single(threads.EnumerateArray()).GetProperty("quote").GetProperty("exact").GetString());

        // Nobody else can see a journal, so a mention in a margin note reaches no one.
        await Task.Delay(500);
        using var scope = app.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var bea = await db.Users.SingleAsync(u => u.Username == "bea");
        Assert.Equal(0, await db.Notifications.CountAsync(n => n.UserId == bea.Id));
    });

    [Fact]
    public Task RenamingATodo_RewritesTheLinkInTheJournal() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/chores", new NoteWrite("Chores", null, null, false, false, "- [ ] dishes", Kind: "todo"));
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = "Did the [[Chores]] today." });
        await app.Client.PutAsJsonAsync("/api/notes/chores", new NoteWrite("Housework", null, null, false, false, "- [ ] dishes", Kind: "todo"));
        string text = string.Empty;
        for (var i = 0; i < 100; i++)
        {
            text = await File.ReadAllTextAsync(app.FileFor(app.Today));
            if (text.Contains("[[Housework]]")) break;
            await Task.Delay(100);
        }
        Assert.Contains("Did the [[Housework]] today.", text);
    });
}

/// <summary>The calendar's reads: whose "today" it is, and ranges across the edges of months, years and leap days.</summary>
public sealed class JournalCalendarTests
{
    [Theory]
    [InlineData("Pacific/Kiritimati")]   // UTC+14
    [InlineData("Pacific/Pago_Pago")]    // UTC−11
    [InlineData("Asia/Kolkata")]
    public Task Today_IsTheAccountsOwnDay(string zone) => JournalEndpointsTests.WithAppAsync(async app =>
    {
        var before = JournalClock.Today(DateTimeOffset.UtcNow, zone, 0);
        var today = (await JournalEndpointsTests.Json(await app.Client.GetAsync("/api/journal/today"))).GetProperty("date").GetString();
        var after = JournalClock.Today(DateTimeOffset.UtcNow, zone, 0);
        Assert.Contains(today, new[] { JournalClock.Format(before), JournalClock.Format(after) });
        // …and writing today lands on that day's file.
        await JournalEndpointsTests.PutDay(app.Client, today!, new { body = "in my own day" });
        Assert.True(File.Exists(app.FileFor(today!)));
    }, timeZone: zone);

    [Fact]
    public Task TheDayStart_MovesTheDayBoundary() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync("/api/journal/settings", new { dayStartsAt = 5 })).StatusCode);
        var before = JournalClock.Today(DateTimeOffset.UtcNow, "UTC", 5);
        var today = (await JournalEndpointsTests.Json(await app.Client.GetAsync("/api/journal/today"))).GetProperty("date").GetString();
        var after = JournalClock.Today(DateTimeOffset.UtcNow, "UTC", 5);
        Assert.Contains(today, new[] { JournalClock.Format(before), JournalClock.Format(after) });

        // The server's own answer also gates writing: the day after "today" is the future.
        var tomorrow = DateOnly.Parse(today!).AddDays(1).ToString("yyyy-MM-dd");
        Assert.Equal((HttpStatusCode)422, (await JournalEndpointsTests.PutDay(app.Client, tomorrow, new { body = "x" })).StatusCode);
    }, timeZone: "UTC");

    [Fact]
    public Task Ranges_CrossMonthsYearsAndLeapDays() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        foreach (var d in new[] { "2023-12-31", "2024-01-01", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01" })
            await JournalEndpointsTests.PutDay(app.Client, d, new { body = "day " + d });

        async Task<string[]> Dates(string from, string to) =>
            (await JournalEndpointsTests.Json(await app.Client.GetAsync($"/api/journal?from={from}&to={to}")))
                .GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("date").GetString()!).ToArray();

        Assert.Equal(["2024-01-31", "2024-02-01"], await Dates("2024-01-31", "2024-02-01"));            // month edge
        Assert.Equal(["2023-12-31", "2024-01-01"], await Dates("2023-12-31", "2024-01-01"));            // year edge
        Assert.Equal(["2024-02-01", "2024-02-29"], await Dates("2024-02-01", "2024-02-29"));            // the leap day is in February
        Assert.Equal(["2024-02-29"], await Dates("2024-02-29", "2024-02-29"));                          // a single day
        Assert.Equal(["2024-03-01"], await Dates("2024-03-01", "2024-03-31"));
        Assert.Empty(await Dates("2024-04-01", "2024-04-30"));
        Assert.Equal(6, (await Dates("2023-12-01", "2024-03-31")).Length);
        // A day with no entry is simply absent: the list is entries, not a grid of days.
        Assert.DoesNotContain("2024-02-15", await Dates("2024-02-01", "2024-02-29"));
    });

    [Fact]
    public Task TheCalendar_ShowsAMoodAndAWordCount_WithoutTheText() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        await JournalEndpointsTests.PutDay(app.Client, app.Today, new { body = "A line of private text ![[photo.jpg]]", mood = 4, tags = new[] { "calm" } });
        var json = await JournalEndpointsTests.Json(await app.Client.GetAsync($"/api/journal?from={app.Today}&to={app.Today}"));
        var e = json.GetProperty("entries")[0];
        Assert.Equal(4, e.GetProperty("mood").GetInt32());
        Assert.Equal("photo.jpg", e.GetProperty("cover").GetString());
        Assert.True(e.GetProperty("hasMedia").GetBoolean());
        Assert.False(e.TryGetProperty("body", out _));
        Assert.Equal(JsonValueKind.Null, e.GetProperty("excerpt").ValueKind); // excerpts are for "on this day" only
    });

    [Fact]
    public Task OnThisDay_ListsEarlierYears_NewestFirst_AndNeverALockedDaysWords() => JournalEndpointsTests.WithAppAsync(async app =>
    {
        var unlock = (await JournalEndpointsTests.Json(await app.Client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin })))
            .GetProperty("unlockToken").GetString();
        await JournalEndpointsTests.PutDay(app.Client, "2025-03-10", new { body = "a year before", mood = 3 });
        await JournalEndpointsTests.PutDay(app.Client, "2024-03-10", new { body = "two years before", mood = 5 });
        await JournalEndpointsTests.PutDay(app.Client, "2023-03-10", new { body = "three years before the zebracode", secure = true });
        await JournalEndpointsTests.PutDay(app.Client, "2025-03-11", new { body = "the day after: not this one" });
        Assert.NotNull(unlock);

        var json = await JournalEndpointsTests.Json(await app.Client.GetAsync("/api/journal/on-this-day?date=2026-03-10"));
        var rows = json.GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(["2025-03-10", "2024-03-10", "2023-03-10"], rows.Select(r => r.GetProperty("date").GetString()));
        Assert.Equal("a year before", rows[0].GetProperty("excerpt").GetString());
        Assert.Equal(JsonValueKind.Null, rows[2].GetProperty("excerpt").ValueKind);
        Assert.DoesNotContain("zebracode", json.ToString());
        // A year's own date never lists itself.
        var self = await JournalEndpointsTests.Json(await app.Client.GetAsync("/api/journal/on-this-day?date=2025-03-10"));
        Assert.DoesNotContain("2025-03-10", self.GetProperty("entries").ToString());
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Client.GetAsync("/api/journal/on-this-day?date=nope")).StatusCode);
    });
}
