using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Settings → Logs: the instance's rolling log. The promise that matters is the
// privacy one — an entry can be pasted into a public GitHub issue — so most of
// these assert what is NOT in the text.
public sealed class ActivityLogTests
{
    private const string Pw = "hunter2!";

    // ── Scrubbing ────────────────────────────────────────────────────────────

    [Fact]
    public void TemplateValuesAreShownOnlyWhenTheirNameSaysTheyAreSafe()
    {
        var text = LogScrubber.RenderTemplate(
            "Saved {NoteId} for {User} in {Elapsed} ms ({Count} files, status {Status})",
            new Dictionary<string, object?>
            {
                ["NoteId"] = "My Secret Diary",
                ["User"] = "alice",
                ["Elapsed"] = 42,
                ["Count"] = 3,
                ["Status"] = 409,
            });

        Assert.Equal("Saved ‹NoteId› for ‹User› in 42 ms (3 files, status 409)", text);
    }

    [Fact]
    public void AnUnknownNumberIsRedactedToo()
    {
        // A uid is a number; being numeric doesn't make it safe.
        var text = LogScrubber.RenderTemplate("Vault {Uid} unlocked", new Dictionary<string, object?> { ["Uid"] = 7 });
        Assert.Equal("Vault ‹Uid› unlocked", text);
    }

    [Fact]
    public void ACountNameCarryingTextIsStillRedacted()
    {
        // "{Moved}" is allowed to show a number, not whatever someone passes as it.
        var text = LogScrubber.RenderTemplate("{Moved} moved, {Count} left",
            new Dictionary<string, object?> { ["Moved"] = "Tax Return 2025", ["Count"] = 2 });
        Assert.Equal("‹Moved› moved, 2 left", text);
    }

    [Theory]
    [InlineData("Could not find file 'C:\\data\\users\\1\\notes\\Diary.md'.", "Diary")]
    [InlineData("Could not find a part of the path \"/data/users/1/notes/Diary.md\".", "Diary")]
    [InlineData("open /data/users/12/notes/taxes failed", "taxes")]
    [InlineData("mail to alice@example.com bounced", "alice")]
    [InlineData("fetch https://bank.example.com/acct?id=9 failed", "bank")]
    [InlineData("note 3f2504e0-4f89-11d3-9a0c-0305e82c3301 is locked", "3f2504e0")]
    [InlineData("connection from 192.168.1.20 refused", "192.168")]
    [InlineData("[1:groceries] slow save: 900ms", "groceries")]
    [InlineData("token=sk_live_abcdefghijklmnop rejected", "sk_live")]
    [InlineData("uploaded holiday-photo.jpg", "holiday")]
    [InlineData("user: alice signed in", "alice")]
    public void FreeTextLosesAnythingIdentifying(string input, string secret)
    {
        var text = LogScrubber.Scrub(input);
        Assert.DoesNotContain(secret, text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void OrdinaryWordsSurviveTheScrub()
    {
        Assert.Equal("SQLite Error 5: database is locked and/or busy (HTTP/1.1)",
            LogScrubber.Scrub("SQLite Error 5: database is locked and/or busy (HTTP/1.1)"));
        Assert.Equal("[collab] [‹…›] opened", LogScrubber.Scrub("[collab] [1:abc] opened"));
    }

    [Fact]
    public void AnExceptionKeepsItsFramesButNotTheBuildMachinesPaths()
    {
        Exception caught;
        try { throw new InvalidOperationException("Couldn't write '/data/users/1/notes/Diary.md'"); }
        catch (Exception ex) { caught = ex; }

        var (type, message, stack) = LogScrubber.Describe(caught);
        Assert.Equal("System.InvalidOperationException", type);
        Assert.DoesNotContain("Diary", message);
        Assert.Contains(nameof(AnExceptionKeepsItsFramesButNotTheBuildMachinesPaths), stack);
        Assert.DoesNotContain(".cs", stack);
        Assert.DoesNotContain(":\\", stack);
    }

    // ── The store ────────────────────────────────────────────────────────────

    [Fact]
    public async Task EntriesComeBackNewestFirstAndOldHoursAreSwept()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-logs-" + Guid.NewGuid().ToString("N"));
        using var store = new ActivityLogStore(dir);
        try
        {
            var now = DateTime.UtcNow;
            store.Add(Entry(now.AddHours(-30), "old"));
            store.Add(Entry(now.AddMinutes(-2), "earlier"));
            store.Add(Entry(now.AddMinutes(-1), "later", "error"));
            await store.FlushAsync();

            var (all, more) = await store.ReadAsync(now.AddDays(-7), null, null, 10);
            Assert.False(more);
            Assert.Equal(["later", "earlier", "old"], all.Select(e => e.Message));

            var (errors, _) = await store.ReadAsync(now.AddDays(-7), "error", null, 10);
            Assert.Equal(["later"], errors.Select(e => e.Message));

            var (page, hasMore) = await store.ReadAsync(now.AddDays(-7), null, null, 1);
            Assert.True(hasMore);
            var (next, _) = await store.ReadAsync(now.AddDays(-7), null, page[0].TimeUtc, 1);
            Assert.Equal("earlier", next.Single().Message);

            Assert.Equal(1, store.Sweep(now.AddHours(-24)));
            var (kept, _) = await store.ReadAsync(now.AddDays(-7), null, null, 10);
            Assert.DoesNotContain(kept, e => e.Message == "old");
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    private static ActivityLogEntry Entry(DateTime at, string message, string level = "info") =>
        new(ActivityLogStore.NewId(), at, level, "Test", message, null);

    // ── End to end ───────────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-log-" + Guid.NewGuid().ToString("N"));
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
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public async Task AnAdminSeesWhatHappenedWithoutWhoItHappenedTo()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest(Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));

            var logger = factory.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Papyra.Api.Storage.TestService");
            logger.LogWarning(new IOException("Couldn't open '/data/users/1/notes/Zebra Diary.md'"),
                "Save of {NoteId} for {User} failed after {Attempts} attempts", "Zebra Diary", "admin-zebra", 3);

            var body = await admin.GetFromJsonAsync<JsonElement>("/api/logs?level=warning");
            var raw = body.GetRawText();
            Assert.DoesNotContain("Zebra", raw);
            Assert.DoesNotContain("admin-zebra", raw);

            var entry = body.GetProperty("entries").EnumerateArray()
                .First(e => e.GetProperty("source").GetString() == "TestService");
            Assert.Equal("Save of ‹NoteId› for ‹User› failed after 3 attempts", entry.GetProperty("message").GetString());
            Assert.Equal("System.IO.IOException", entry.GetProperty("exception").GetProperty("type").GetString());
            Assert.Equal(168, body.GetProperty("retentionHours").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OnlyAnAdminCanReadOrChangeTheLog()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest(Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));

            var bea = factory.CreateClient();
            await bea.LoginAsync("bea", Pw);
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/logs")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.DeleteAsync("/api/logs")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bea.PutAsJsonAsync("/api/logs/retention", new { hours = 24 })).StatusCode);

            // …but anyone signed in can report their browser's crash into it.
            var report = await bea.PostAsJsonAsync("/api/logs/client", new
            {
                message = "Cannot read properties of undefined (reading 'title') for bea@example.com",
                type = "TypeError",
                stack = "at NoteCard (NoteCard-abc123.js:10:5)",
                route = "/note/:id",
            });
            Assert.Equal(HttpStatusCode.Accepted, report.StatusCode);

            var body = await admin.GetFromJsonAsync<JsonElement>("/api/logs?level=error");
            var browser = body.GetProperty("entries").EnumerateArray()
                .First(e => e.GetProperty("source").GetString() == "Browser");
            var message = browser.GetProperty("message").GetString()!;
            Assert.DoesNotContain("bea@", message);
            Assert.Contains("(on /note/:id)", message);
            Assert.Equal("TypeError", browser.GetProperty("exception").GetProperty("type").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task RetentionTakesOnlyTheListedPeriodsAndClearEmptiesTheLog()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest(Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));

            Assert.Equal(HttpStatusCode.BadRequest,
                (await admin.PutAsJsonAsync("/api/logs/retention", new { hours = 5 })).StatusCode);
            Assert.Equal(HttpStatusCode.OK,
                (await admin.PutAsJsonAsync("/api/logs/retention", new { hours = 24 })).StatusCode);
            var body = await admin.GetFromJsonAsync<JsonElement>("/api/logs");
            Assert.Equal(24, body.GetProperty("retentionHours").GetInt32());

            factory.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Papyra.Api.Test").LogInformation("hello");
            Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync("/api/logs")).StatusCode);
            var after = await admin.GetFromJsonAsync<JsonElement>("/api/logs");
            Assert.Empty(after.GetProperty("entries").EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }
}
