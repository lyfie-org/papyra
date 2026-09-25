using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// Sprint 7.1: prior revisions are archived on overwrite, listable, fetchable, and
// an external truncation can be rolled back from a snapshot via the restore route.
public sealed class SnapshotEndpointsTests
{
    // `unthrottled` sets the snapshot min-interval to zero so every write may
    // archive — isolating the content de-duplication from the time throttle.
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(bool unthrottled = false)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            if (unthrottled) b.UseSetting("Papyra:SnapshotMinIntervalSeconds", "0");
        });
        return (factory, dir);
    }

    private static Task<HttpResponseMessage> Put(HttpClient client, string id, string body,
        string title = "Doc", bool pinned = false, string? color = null, List<string>? tags = null)
        => client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: title, Tags: tags, Color: color, Pinned: pinned, Archived: false, Body: body));

    private static async Task<List<string>> Bodies(HttpClient client, string id)
    {
        var list = await client.GetFromJsonAsync<List<SnapshotDto>>($"/api/notes/{id}/snapshots");
        var bodies = new List<string>();
        foreach (var s in list!)
            bodies.Add((await client.GetFromJsonAsync<Note>($"/api/notes/{id}/snapshots/{s.Id}"))!.Body.Trim());
        return bodies;
    }

    private static async Task InApp(bool unthrottled, Func<HttpClient, string, string, Task> test)
    {
        var (factory, dir) = NewApp(unthrottled);
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);
            await test(client, uid, dir);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public Task MetadataOnlyAndAnchorOnlySaves_DoNotCreateVersions() => InApp(unthrottled: true, async (client, _, _) =>
    {
        await Put(client, "d1", "Line one");
        await Put(client, "d1", "Line one", pinned: true);                 // pin flip
        await Put(client, "d1", "Line one", pinned: true, color: "#fde"); // colour
        await Put(client, "d1", "Line one ^abc12345", pinned: true);      // anchor stamp
        await Put(client, "d1", "Line one  \r\n", pinned: true);          // whitespace noise
        await Put(client, "d1", "Line two");                                // real change

        // Only "Line one" is a distinct earlier version — once.
        Assert.Equal(["Line one"], (await Bodies(client, "d1")).Select(b => b.Replace(" ^abc12345", "")).Distinct());
        Assert.Single(await Bodies(client, "d1"));
    });

    [Fact]
    public Task EveryListedVersion_DiffersFromItsNeighbourAndFromNow() => InApp(unthrottled: true, async (client, _, _) =>
    {
        foreach (var body in new[] { "v1", "v1", "v2", "v2", "v2", "v3", "v3" })
            await Put(client, "d2", body);

        var bodies = await Bodies(client, "d2"); // newest first
        Assert.Equal(["v2", "v1"], bodies);       // v3 is the live note: hidden
    });

    [Fact]
    public Task NonAdjacentRepeats_AreKept() => InApp(unthrottled: true, async (client, _, _) =>
    {
        foreach (var body in new[] { "A", "B", "A", "C" })
            await Put(client, "d3", body);
        Assert.Equal(["A", "B", "A"], await Bodies(client, "d3"));
    });

    [Fact]
    public Task TitleChange_IsAVersion() => InApp(unthrottled: true, async (client, _, _) =>
    {
        await Put(client, "d4", "same", title: "Old");
        await Put(client, "d4", "same", title: "New");
        var list = await client.GetFromJsonAsync<List<SnapshotDto>>("/api/notes/d4/snapshots");
        var snap = Assert.Single(list!);
        var old = await client.GetFromJsonAsync<Note>($"/api/notes/d4/snapshots/{snap.Id}");
        Assert.Equal("Old", old!.Title);
    });

    [Fact]
    public Task ExistingDuplicateFiles_AreCollapsedInTheListing() => InApp(unthrottled: false, async (client, uid, dir) =>
    {
        // History written before de-duplication existed: three copies of one body.
        await Put(client, "d5", "live");
        var snapDir = Path.Combine(dir, "users", uid, ".papyra", "snapshots", "d5");
        Directory.CreateDirectory(snapDir);
        var t = DateTime.UtcNow.AddHours(-3).Ticks;
        foreach (var (offset, body) in new[] { (0L, "old"), (1L, "old"), (2L, "old ^zz999999"), (3L, "mid"), (4L, "live") })
            await File.WriteAllTextAsync(Path.Combine(snapDir, $"{t + offset * TimeSpan.TicksPerMinute}.md"),
                $"---\ntitle: Doc\n---\n{body}\n");

        var bodies = await Bodies(client, "d5");
        Assert.Equal(["mid", "old ^zz999999"], bodies); // one "old" (the newest copy), no "live"
    });

    [Fact]
    public Task Restore_WithinThrottleWindow_StillArchivesTheReplacedVersion_AndCanBeUndone() => InApp(unthrottled: false, async (client, _, _) =>
    {
        // Default 5-minute throttle: v1 archived when v2 lands; v2 → v3 within the
        // window is throttled, so v2 is NOT in history yet.
        await Put(client, "r1", "v1");
        await Put(client, "r1", "v2");
        await Put(client, "r1", "v3");
        var list = await client.GetFromJsonAsync<List<SnapshotDto>>("/api/notes/r1/snapshots");
        var v1 = Assert.Single(list!);

        // Restoring v1 must archive v3 regardless of the throttle.
        var res = await client.PostAsync($"/api/notes/r1/restore/{v1.Id}", content: null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("v1", (await res.Content.ReadFromJsonAsync<Note>())!.Body.Trim());
        var undoId = Assert.Single(res.Headers.GetValues("Papyra-Undo-Snapshot"));

        var undo = await client.GetFromJsonAsync<Note>($"/api/notes/r1/snapshots/{undoId}");
        Assert.Equal("v3", undo!.Body.Trim());

        // Undo the restore.
        var back = await client.PostAsync($"/api/notes/r1/restore/{undoId}", content: null);
        Assert.Equal(HttpStatusCode.OK, back.StatusCode);
        var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
        Assert.Equal("v3", notes!.Single(n => n.Id == "r1").Body.Trim());
    });

    [Fact]
    public Task RestoreTwiceQuickly_DoesNotOverwriteASnapshot() => InApp(unthrottled: false, async (client, _, _) =>
    {
        await Put(client, "r2", "a");
        await Put(client, "r2", "b");
        var a = Assert.Single((await client.GetFromJsonAsync<List<SnapshotDto>>("/api/notes/r2/snapshots"))!);
        var r1 = await client.PostAsync($"/api/notes/r2/restore/{a.Id}", content: null);
        var undoB = r1.Headers.GetValues("Papyra-Undo-Snapshot").Single();
        var r2 = await client.PostAsync($"/api/notes/r2/restore/{undoB}", content: null);
        var undoA = r2.Headers.GetValues("Papyra-Undo-Snapshot").Single();

        Assert.Equal("b", (await client.GetFromJsonAsync<Note>($"/api/notes/r2/snapshots/{undoB}"))!.Body.Trim());
        Assert.Equal("a", (await client.GetFromJsonAsync<Note>($"/api/notes/r2/snapshots/{undoA}"))!.Body.Trim());
    });

    [Fact]
    public Task Restore_OfACopyWithoutAnId_KeepsTheNoteInTheVault() => InApp(unthrottled: false, async (client, uid, dir) =>
    {
        await Put(client, "r3", "live");
        var snapDir = Path.Combine(dir, "users", uid, ".papyra", "snapshots", "r3");
        Directory.CreateDirectory(snapDir);
        var ticks = DateTime.UtcNow.AddHours(-1).Ticks;
        // Last written by another editor: foreign key kept, no `id`.
        await File.WriteAllTextAsync(Path.Combine(snapDir, $"{ticks}.md"), "---\ntitle: Old\naliases: [x]\n---\nold body\n");

        var res = await client.PostAsync($"/api/notes/r3/restore/{ticks}", content: null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("r3", (await res.Content.ReadFromJsonAsync<Note>())!.Id);

        var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
        var restored = Assert.Single(notes!, n => n.Id == "r3");
        Assert.Equal("old body", restored.Body.Trim());
        var raw = await File.ReadAllTextAsync(Path.Combine(dir, "users", uid, "notes", "r3.md"));
        Assert.Contains("aliases", raw); // foreign frontmatter survives the id fix-up
    });

    [Theory]
    [InlineData("Para ^abc12345", "Para")]
    [InlineData("1. A\r\n2. B  ", "1. A\n2. B")]
    [InlineData("x\n\n", "x")]
    public void Fingerprint_IgnoresInvisibleNoise(string a, string b)
        => Assert.Equal(Papyra.Api.Storage.SnapshotService.Fingerprint("T", a), Papyra.Api.Storage.SnapshotService.Fingerprint("T", b));

    [Theory]
    [InlineData("A", "a")]
    [InlineData("  indented", "indented")]
    [InlineData("1. A", "1. A\n2.")]
    public void Fingerprint_SeesRealChanges(string a, string b)
        => Assert.NotEqual(Papyra.Api.Storage.SnapshotService.Fingerprint("T", a), Papyra.Api.Storage.SnapshotService.Fingerprint("T", b));

    private static async Task<string> SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
    }

    private sealed record SnapshotDto(string Id, DateTime Timestamp);

    [Fact]
    public async Task SecondWrite_ArchivesPriorRevision_ThenRestoreRollsBack()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);

            // v1 then v2 → the v1 revision is archived before v2 overwrites it.
            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Doc", Tags: null, Color: null, Pinned: false, Archived: false, Body: "first version"));
            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Doc", Tags: null, Color: null, Pinned: false, Archived: false, Body: "second version"));

            var list = await client.GetFromJsonAsync<List<SnapshotDto>>("/api/notes/s1/snapshots");
            var snap = Assert.Single(list!);

            // The archived body is the prior (v1) content.
            var archived = await client.GetFromJsonAsync<Note>($"/api/notes/s1/snapshots/{snap.Id}");
            Assert.Contains("first version", archived!.Body);

            // Truncate the live note externally, then restore from the snapshot.
            var mdPath = Path.Combine(dir, "users", uid, "notes", "s1.md");
            await File.WriteAllTextAsync(mdPath, "");

            var restore = await client.PostAsync($"/api/notes/s1/restore/{snap.Id}", content: null);
            Assert.Equal(HttpStatusCode.OK, restore.StatusCode);

            var raw = await File.ReadAllTextAsync(mdPath);
            Assert.Contains("first version", raw);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
