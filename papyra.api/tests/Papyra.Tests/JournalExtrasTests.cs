using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Papyra.Api.Storage;
using static Papyra.Tests.JournalEndpointsTests;

namespace Papyra.Tests;

/// <summary>The days set aside, templates, journal import and export, and the reminder's clock.</summary>
public sealed class JournalExtrasTests
{
    // ── Archive and Trash ────────────────────────────────────────────────────────

    [Fact]
    public Task TheBin_ListsArchivedAndTrashedDays_NewestFirst_AndIsThePersonsAlone() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Day(1), new { body = "keep this one" });
        await PutDay(app.Client, app.Day(2), new { body = "tuck this away", archived = true });
        await PutDay(app.Client, app.Day(3), new { body = "older, archived", archived = true });
        await PutDay(app.Client, app.Day(4), new { body = "bin me" });
        await app.Client.PostAsync($"/api/notes/journal-{app.Day(4)}/trash", null);

        var archived = await Json(await app.Client.GetAsync("/api/journal/bin"));
        Assert.Equal("archived", archived.GetProperty("state").GetString());
        Assert.Equal([app.Day(2), app.Day(3)], archived.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("date").GetString()!).ToArray());

        var trashed = await Json(await app.Client.GetAsync("/api/journal/bin?state=trashed"));
        var only = Assert.Single(trashed.GetProperty("entries").EnumerateArray().ToList());
        Assert.Equal(app.Day(4), only.GetProperty("date").GetString());
        Assert.NotEqual(JsonValueKind.Null, only.GetProperty("trashedAt").ValueKind);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await app.Client.GetAsync("/api/journal/bin?state=nope")).StatusCode);
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        Assert.Equal(HttpStatusCode.Forbidden, (await key.GetAsync("/api/journal/bin")).StatusCode);
    });

    // ── Templates ────────────────────────────────────────────────────────────────

    [Fact]
    public Task Templates_AreSavedUnderDotPapyra_NeverAsNotes_AndTheDefaultMustExist() => WithAppAsync(async app =>
    {
        var put = await app.Client.PutAsJsonAsync("/api/journal/templates/Evening%20review", new { body = "## {{weekday}}\n\nOne good thing:\n" });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.Equal("Evening review", (await Json(put)).GetProperty("name").GetString());

        var file = Path.Combine(app.Dir, "users", app.Uid, ".papyra", "journal-templates", "Evening review.md");
        Assert.True(File.Exists(file));
        Assert.Contains("One good thing", await File.ReadAllTextAsync(file));
        Assert.Empty(await app.Client.GetFromJsonAsync<JsonElement[]>("/api/notes") ?? []); // not adopted as a note

        var list = await Json(await app.Client.GetAsync("/api/journal/templates"));
        Assert.Equal("Evening review", Assert.Single(list.GetProperty("templates").EnumerateArray().ToList()).GetProperty("name").GetString());

        // The default has to be one of them.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await app.Client.PutAsJsonAsync("/api/journal/settings", new { defaultTemplate = "Nope" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync("/api/journal/settings", new { defaultTemplate = "Evening review" })).StatusCode);
        Assert.Equal("Evening review", (await Json(await app.Client.GetAsync("/api/journal/templates"))).GetProperty("defaultTemplate").GetString());

        // Removing it also lets go of the default.
        Assert.Equal(HttpStatusCode.NoContent, (await app.Client.DeleteAsync("/api/journal/templates/Evening%20review")).StatusCode);
        Assert.False(File.Exists(file));
        Assert.Equal(JsonValueKind.Null, (await Json(await app.Client.GetAsync("/api/journal/templates"))).GetProperty("defaultTemplate").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await app.Client.DeleteAsync("/api/journal/templates/Evening%20review")).StatusCode);
    });

    [Theory]
    [InlineData("..%2F..%2Fescape")]
    [InlineData("a%2Fb")]
    [InlineData("CON")]
    [InlineData("nul.txt")]
    [InlineData(".hidden")]
    [InlineData("trailing.")]
    public Task ATemplateName_ThatCouldEscapeOrBeADevice_IsRefused(string name) => WithAppAsync(async app =>
    {
        var res = await app.Client.PutAsJsonAsync($"/api/journal/templates/{name}", new { body = "x" });
        Assert.True(res.StatusCode is HttpStatusCode.UnprocessableEntity or HttpStatusCode.NotFound, $"{name}: {res.StatusCode}");
        var dir = Path.Combine(app.Dir, "users", app.Uid, ".papyra", "journal-templates");
        Assert.False(Directory.Exists(dir) && Directory.EnumerateFiles(dir).Any());
        Assert.False(File.Exists(Path.Combine(app.Dir, "users", app.Uid, "escape.md")));
    });

    [Fact]
    public Task Templates_AreBounded_AndNotAKeysToTouch() => WithAppAsync(async app =>
    {
        var big = await app.Client.PutAsJsonAsync("/api/journal/templates/Big", new { body = new string('x', JournalTemplates.MaxBytes + 1) });
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);

        for (var i = 0; i < JournalTemplates.MaxTemplates; i++)
            Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync($"/api/journal/templates/T{i}", new { body = "x" })).StatusCode);
        var extra = await app.Client.PutAsJsonAsync("/api/journal/templates/OneMore", new { body = "x" });
        Assert.Equal(HttpStatusCode.Conflict, extra.StatusCode);
        // Replacing one that exists is still fine at the limit.
        Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync("/api/journal/templates/T0", new { body = "changed" })).StatusCode);

        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        Assert.Equal(HttpStatusCode.Forbidden, (await key.GetAsync("/api/journal/templates")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await key.PutAsJsonAsync("/api/journal/templates/K", new { body = "x" })).StatusCode);
    });

    // ── Import ───────────────────────────────────────────────────────────────────

    private static byte[] Zip(params (string Name, byte[] Content)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, content) in entries)
            {
                var e = zip.CreateEntry(name);
                e.LastWriteTime = new DateTimeOffset(2024, 3, 5, 10, 0, 0, TimeSpan.Zero);
                using var s = e.Open();
                s.Write(content);
            }
        return ms.ToArray();
    }

    private static (string, byte[]) Text(string name, string content) => (name, Encoding.UTF8.GetBytes(content));

    private static async Task<JsonElement> ImportAsync(HttpClient client, string provider, byte[] zip)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(zip);
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
        form.Add(file, "file", "import.zip");
        var res = await client.PostAsync($"/api/import/{provider}", form);
        Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);
        var jobId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString();
        for (var i = 0; i < 150; i++)
        {
            var status = await client.GetFromJsonAsync<JsonElement>("/api/import/status");
            if (status.GetProperty("jobId").GetString() == jobId && status.GetProperty("done").GetBoolean()) return status;
            await Task.Delay(100);
        }
        throw new TimeoutException("Import never finished.");
    }

    private static int N(JsonElement status, string name) => status.GetProperty(name).GetInt32();

    [Fact]
    public Task DatedFiles_BecomeDays_AndAnImportTwiceAddsNothing() => WithAppAsync(async app =>
    {
        var zip = Zip(
            Text("vault/Daily/2024-03-02.md", "---\ntags: [walk]\nmood: 4\n---\nWent up the hill."),
            Text("vault/Daily/2024-03-03 trip.md", "Booked the train."),
            Text("vault/Daily/2024-03-03.md", "Rain all day."),
            Text("vault/.obsidian/2024-03-09.md", "settings, not a day"),
            Text("vault/readme.md", "not dated"),
            Text("vault/Daily/2999-01-01.md", "from the future"));

        var first = await ImportAsync(app.Client, "journal", zip);
        Assert.Equal(2, N(first, "imported"));
        Assert.Equal(1, N(first, "skipped")); // the future one

        var two = await Json(await app.Client.GetAsync("/api/journal/2024-03-02"));
        Assert.Equal("Went up the hill.", two.GetProperty("body").GetString());
        Assert.Equal(4, two.GetProperty("mood").GetInt32());
        Assert.Contains("walk", two.GetProperty("tags").EnumerateArray().Select(t => t.GetString()));
        var three = (await Json(await app.Client.GetAsync("/api/journal/2024-03-03"))).GetProperty("body").GetString()!;
        Assert.Contains("Rain all day.", three);
        Assert.Contains("Booked the train.", three); // two files, one day: both kept
        Assert.False((await Json(await app.Client.GetAsync("/api/journal/2024-03-09"))).GetProperty("exists").GetBoolean());

        var again = await ImportAsync(app.Client, "journal", zip);
        Assert.Equal(0, N(again, "imported"));
        Assert.Equal(0, N(again, "updated"));
        Assert.Equal(2, N(again, "unchanged"));
        Assert.Equal(three, (await Json(await app.Client.GetAsync("/api/journal/2024-03-03"))).GetProperty("body").GetString());
    });

    [Fact]
    public Task ADayThatAlreadyHasWriting_KeepsBoth_AndALockedDayIsNeverOpened() => WithAppAsync(async app =>
    {
        var unlock = (await Json(await app.Client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin }))).GetProperty("unlockToken").GetString()!;
        await PutDay(app.Client, "2024-03-02", new { body = "what I wrote then", mood = 3 });
        await PutDay(app.Client, "2024-03-04", new { body = "locked zebracode", secure = true });

        var status = await ImportAsync(app.Client, "journal", Zip(
            Text("2024-03-02.md", "what I wrote elsewhere"),
            Text("2024-03-04.md", "should not land")));
        Assert.Equal(1, N(status, "updated"));
        Assert.Equal(1, N(status, "skipped"));

        var kept = await Json(await app.Client.GetAsync("/api/journal/2024-03-02"));
        var body = kept.GetProperty("body").GetString()!;
        Assert.StartsWith("what I wrote then", body);
        Assert.Contains("## Imported from a file", body);
        Assert.EndsWith("what I wrote elsewhere", body);
        Assert.Equal(3, kept.GetProperty("mood").GetInt32());

        var reveal = new HttpRequestMessage(HttpMethod.Get, "/api/notes/journal-2024-03-04/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("locked zebracode", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());
    });

    [Fact]
    public Task DayOne_BecomesDays_WithTheirPhotos_AndTheirOwnZone() => WithAppAsync(async app =>
    {
        // PNG signature + a minimal IHDR is all the sniffer needs to call it a picture.
        byte[] png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89];
        var json = """
        {"metadata":{"version":"1.0"},"entries":[
          {"uuid":"E0","creationDate":"2024-03-02T10:00:00Z","timeZone":"Asia/Kolkata","text":"Earlier on the second."},
          {"uuid":"E1","creationDate":"2024-03-02T23:30:00Z","timeZone":"Asia/Kolkata",
           "text":"Lovely day\\. We walked\\!\n\n![](dayone-moment://PH1)\n\nHome by six\\.",
           "tags":["walk","family"],"photos":[{"identifier":"PH1","md5":"abc123","type":"png"}]},
          {"uuid":"E2","creationDate":"2024-03-03T08:00:00Z","timeZone":"Asia/Kolkata","text":"Next morning, early."},
          {"uuid":"E3","creationDate":"2024-03-03T10:00:00Z","timeZone":"Asia/Kolkata","text":"   "}
        ]}
        """;
        var zip = Zip(("Journal.json", Encoding.UTF8.GetBytes(json)), ("photos/abc123.png", png));

        var status = await ImportAsync(app.Client, "dayone", zip);
        Assert.Equal(2, N(status, "imported"));

        Assert.Equal("Earlier on the second.", (await Json(await app.Client.GetAsync("/api/journal/2024-03-02"))).GetProperty("body").GetString());
        // 23:30 UTC is already the 3rd in Kolkata: the day follows the entry's own zone.
        var third = await Json(await app.Client.GetAsync("/api/journal/2024-03-03"));
        var thirdBody = third.GetProperty("body").GetString()!;
        Assert.StartsWith("Lovely day. We walked!", thirdBody);
        Assert.Contains("Home by six.", thirdBody);
        Assert.Contains("Next morning, early.", thirdBody);
        Assert.Contains("walk", third.GetProperty("tags").EnumerateArray().Select(t => t.GetString()));
        Assert.DoesNotContain("dayone-moment", thirdBody);
        var embed = System.Text.RegularExpressions.Regex.Match(thirdBody, @"!\[\[(?<n>[^\]]+\.png)\]\]");
        Assert.True(embed.Success, thirdBody);
        Assert.True(File.Exists(Path.Combine(app.Dir, "users", app.Uid, "media", embed.Groups["n"].Value)));

        var again = await ImportAsync(app.Client, "dayone", zip);
        Assert.Equal(0, N(again, "imported"));
        Assert.Equal(0, N(again, "updated"));
        Assert.Equal(2, N(again, "unchanged")); // already there, not doubled
        Assert.Equal(thirdBody, (await Json(await app.Client.GetAsync("/api/journal/2024-03-03"))).GetProperty("body").GetString());
    });

    [Fact]
    public Task AnArchiveThatIsNotAJournal_FailsWithAnExplanation() => WithAppAsync(async app =>
    {
        var status = await ImportAsync(app.Client, "dayone", Zip(Text("notes.txt", "hello")));
        Assert.Contains("Day One", status.GetProperty("error").GetString());
        Assert.Equal(0, N(status, "imported"));
    });

    // ── Export ───────────────────────────────────────────────────────────────────

    [Fact]
    public Task TheExport_CarriesTheJournal_LockedDaysReadableUnderVault() => WithAppAsync(async app =>
    {
        var token = app.Factory.Services.GetRequiredService<UnlockTokenStore>().Issue(app.Uid);
        await PutDay(app.Client, app.Day(1), new { body = "open day zebracode" });
        await PutDay(app.Client, app.Day(2), new { body = "closed day zebracode", secure = true });

        var authorize = new HttpRequestMessage(HttpMethod.Post, "/api/export/authorize") { Content = JsonContent.Create(new { code = await TestAuth.CodeAsync(app.Client) }) };
        authorize.Headers.Add("X-Unlock-Token", token);
        var ticket = (await Json(await app.Client.SendAsync(authorize))).GetProperty("ticket").GetString();

        var res = await app.Client.GetAsync($"/api/export?ticket={ticket}");
        using var zip = new ZipArchive(await res.Content.ReadAsStreamAsync());
        string Read(string name) => new StreamReader(zip.GetEntry(name)!.Open()).ReadToEnd();
        var open = $"journal/{app.Day(1)[..4]}/{app.Day(1).Substring(5, 2)}/{app.Day(1)}.md";
        var closed = $"vault/journal/{app.Day(2)[..4]}/{app.Day(2).Substring(5, 2)}/{app.Day(2)}.md";
        Assert.Contains("open day zebracode", Read(open));
        Assert.Contains("closed day zebracode", Read(closed)); // sealed on disk, readable in the export
        Assert.Contains("kind: journal", Read(open));
    });

    // ── Scale ────────────────────────────────────────────────────────────────────

    [Fact]
    public Task AThousandDays_NeverChangeWhatTheDeskSees_AndTheCalendarStaysQuick() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/desk-note", new { title = "Desk note", body = "plain" });
        var notesBefore = await app.Client.GetStringAsync("/api/notes");
        var tagsBefore = await app.Client.GetStringAsync("/api/categories");

        var state = app.Factory.Services.GetRequiredService<VaultState>();
        var today = DateOnly.Parse(app.Today);
        for (var i = 0; i < 1000; i++)
        {
            var date = today.AddDays(-i).ToString("yyyy-MM-dd");
            state.Upsert(app.Uid, app.FileFor(date), new Papyra.Api.Models.Note
            {
                Id = "journal-" + date, Title = date, Kind = "journal", Tags = ["thousand"],
                Body = "thousand days of writing, day " + i, Updated = DateTime.UtcNow,
            });
        }

        // Nothing the desk shows moved: not the list, and not the tag list a thousand tagged days would grow.
        Assert.Equal(notesBefore, await app.Client.GetStringAsync("/api/notes"));
        Assert.Equal(tagsBefore, await app.Client.GetStringAsync("/api/categories"));

        var clock = System.Diagnostics.Stopwatch.StartNew();
        var range = await Json(await app.Client.GetAsync($"/api/journal?from={app.Day(999)}&to={app.Today}"));
        clock.Stop();
        Assert.Equal(1000, range.GetProperty("entries").GetArrayLength());
        Assert.True(clock.ElapsedMilliseconds < 3000, $"a thousand days took {clock.ElapsedMilliseconds} ms");
        Assert.Equal(1000, (await Json(await app.Client.GetAsync("/api/journal/stats"))).GetProperty("totalDays").GetInt32());
    });

    // ── Backup ───────────────────────────────────────────────────────────────────

    [Fact]
    public Task ABackup_CarriesTheTemplatesAndThePreferences_AndRestoresThem() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/journal/templates/Morning", new { body = "## {{date}}\n\nIntention:\n" });
        await app.Client.PutAsJsonAsync("/api/journal/settings", new { dayStartsAt = 4, hideStreak = true, defaultTemplate = "Morning" });

        var layout = new BackupLayout(app.Factory.Services.GetRequiredService<MarkdownStorageService>(),
            app.Factory.Services.GetRequiredService<IConfiguration>(), app.Factory.Services.GetRequiredService<IHostEnvironment>(),
            app.Factory.Services.GetRequiredService<LockedNoteCipher>(), app.Factory.Services.GetRequiredService<LockedNoteSealer>());
        var dest = Path.Combine(app.Dir, "backup-out");
        using (var scope = app.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
            var user = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.FirstAsync(db.Users);
            await layout.BuildAsync(user, db, dest, default, sealedVault: true);
        }
        Assert.Contains("Intention", await File.ReadAllTextAsync(Path.Combine(dest, "settings", "journal-templates", "Morning.md")));
        Assert.Contains("\"dayStartsAt\":4", await File.ReadAllTextAsync(Path.Combine(dest, "settings", "journal.json")));

        // Lose them, restore, and they are back.
        var dot = Path.Combine(app.Dir, "users", app.Uid, ".papyra");
        Directory.Delete(Path.Combine(dot, "journal-templates"), recursive: true);
        File.Delete(Path.Combine(dot, "journal.json"));
        using (var scope = app.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
            var user = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.FirstAsync(db.Users);
            await layout.ApplyAsync(dest, user, db, restoreProfile: false, default);
        }
        var list = await Json(await app.Client.GetAsync("/api/journal/templates"));
        Assert.Equal("Morning", Assert.Single(list.GetProperty("templates").EnumerateArray().ToList()).GetProperty("name").GetString());
        var prefs = (await Json(await app.Client.GetAsync("/api/journal/settings"))).GetProperty("settings");
        Assert.Equal(4, prefs.GetProperty("dayStartsAt").GetInt32());
        Assert.True(prefs.GetProperty("hideStreak").GetBoolean());
        Assert.Equal("Morning", prefs.GetProperty("defaultTemplate").GetString());
    });

    // ── The reminder's clock ─────────────────────────────────────────────────────

    private static DateTimeOffset Utc(string iso) => DateTimeOffset.Parse(iso, null, System.Globalization.DateTimeStyles.AssumeUniversal);

    [Fact]
    public void TheReminder_WaitsForItsHour_InThePersonsOwnZone()
    {
        // 21:30 in Kolkata is 16:00 UTC.
        Assert.Null(JournalReminderJob.DueDay(Utc("2026-10-25T15:59:00Z"), "Asia/Kolkata", 0, "21:30", null));
        Assert.Equal(new DateOnly(2026, 10, 25), JournalReminderJob.DueDay(Utc("2026-10-25T16:00:00Z"), "Asia/Kolkata", 0, "21:30", null));
        // The same instant in Tokyo is 01:00 the next morning: not the hour yet for that day.
        Assert.Null(JournalReminderJob.DueDay(Utc("2026-10-25T16:00:00Z"), "Asia/Tokyo", 0, "21:30", null));
    }

    [Fact]
    public void TheReminder_IsSentOncePerDay_AndNeverBeforeTheDayHasTurnedOver()
    {
        var evening = Utc("2026-10-25T22:00:00Z");
        Assert.Null(JournalReminderJob.DueDay(evening, null, 0, "21:30", "2026-10-25"));
        Assert.NotNull(JournalReminderJob.DueDay(evening, null, 0, "21:30", "2026-10-24"));
        // 01:00 with the day starting at 03:00 is still yesterday's page: a 00:30 reminder isn't due now.
        Assert.Null(JournalReminderJob.DueDay(Utc("2026-10-26T01:00:00Z"), null, 3, "00:30", null));
        // An unset or garbled time never fires.
        Assert.Null(JournalReminderJob.DueDay(evening, null, 0, null, null));
        Assert.Null(JournalReminderJob.DueDay(evening, null, 0, "9pm", null));
    }
}
