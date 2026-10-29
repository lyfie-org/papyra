using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Collab;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using static Papyra.Tests.JournalEndpointsTests;

namespace Papyra.Tests;

/// <summary>A to-do embedded in a journal day is the real to-do: parsing, ticking, and the careful write behind it.</summary>
public sealed class ChecklistTests
{
    // ── The markdown ────────────────────────────────────────────────────────────

    [Fact]
    public void Parse_ReadsItemsInOrder_AtAnyDepth_SkippingFencedCode()
    {
        var body = "Shopping\n\n- [ ] milk\n- [x] bread ^ab12cd34\n  - [ ] oat milk\n* [X] eggs\n\n```\n- [ ] not an item\n```\n\n- [ ]\n- [ ] last";
        var items = Checklist.Parse(body);
        Assert.Equal(["milk", "bread", "oat milk", "eggs", "last"], items.Select(i => i.Text));
        Assert.Equal([false, true, false, true, false], items.Select(i => i.Checked));
        Assert.Equal([0, 1, 2, 3, 4], items.Select(i => i.Index));
    }

    [Fact]
    public void Render_IsJustTheItems_ForTheEmbedToResolve()
    {
        Assert.Equal("- [ ] milk\n- [x] bread", Checklist.Render("Intro text\n\n- [ ] milk\n- [X] bread\n\nclosing words"));
        Assert.Equal(string.Empty, Checklist.Render("no list here"));
        Assert.Equal(string.Empty, Checklist.Render(null));
    }

    [Fact]
    public void Set_TicksOnlyTheMark_AndLeavesEverythingElseAsWritten()
    {
        var body = "# Chores\n\n- [ ] dishes ^k1\n  - [ ] sink\n- [x] bins";
        var (status, next) = Checklist.Set(body, 0, "dishes", true);
        Assert.Equal(Checklist.TickStatus.Changed, status);
        Assert.Equal("# Chores\n\n- [x] dishes ^k1\n  - [ ] sink\n- [x] bins", next);

        var (_, undone) = Checklist.Set(next, 2, "bins", false);
        Assert.Equal("# Chores\n\n- [x] dishes ^k1\n  - [ ] sink\n- [ ] bins", undone);
    }

    [Fact]
    public void Set_KeepsCrlfFilesCrlf()
    {
        var (_, next) = Checklist.Set("- [ ] a\r\n- [ ] b\r\n", 1, "b", true);
        Assert.Equal("- [ ] a\r\n- [x] b\r\n", next);
    }

    [Fact]
    public void Set_AlreadyThatWay_ChangesNothing()
    {
        Assert.Equal(Checklist.TickStatus.Unchanged, Checklist.Set("- [x] a", 0, "a", true).Status);
    }

    [Fact]
    public void Set_NoticesAListThatMovedOn_NeverTicksTheWrongItem()
    {
        // Drawn when "milk" was item 0; since then an item was added above it.
        var body = "- [ ] bread\n- [ ] milk\n- [ ] eggs";
        var (found, next) = Checklist.Set(body, 0, "milk", true);
        Assert.Equal(Checklist.TickStatus.Changed, found);          // found by its text, not its old place
        Assert.Equal("- [ ] bread\n- [x] milk\n- [ ] eggs", next);

        // Gone, or ambiguous: stale, nothing touched.
        Assert.Equal(Checklist.TickStatus.Stale, Checklist.Set(body, 0, "tea", true).Status);
        Assert.Equal(Checklist.TickStatus.Stale, Checklist.Set("- [ ] a\n- [ ] x\n- [ ] x", 0, "x", true).Status);
        Assert.Equal(Checklist.TickStatus.Stale, Checklist.Set(body, 99, "nothing", true).Status);
    }

    // ── The API ─────────────────────────────────────────────────────────────────

    private static Task<HttpResponseMessage> Tick(HttpClient c, string id, int index, string text, bool on) =>
        c.PostAsJsonAsync($"/api/notes/{id}/checklist/check", new { index, text, @checked = on });

    private static async Task MakeTodo(HttpClient c, string id, string title, string body, bool secure = false) =>
        Assert.Equal(HttpStatusCode.OK, (await c.PutAsJsonAsync($"/api/notes/{id}",
            new NoteWrite(title, null, null, false, false, body, Kind: "todo", Secure: secure ? true : null))).StatusCode);

    [Fact]
    public Task Ticking_ChangesTheRealTodoNote_AndKeepsAVersion() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "chores", "Chores", "- [ ] dishes\n- [ ] bins");
        var read = await Json(await app.Client.GetAsync("/api/notes/chores/checklist"));
        Assert.Equal(2, read.GetProperty("items").GetArrayLength());

        var res = await Tick(app.Client, "chores", 1, "bins", true);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var items = (await Json(res)).GetProperty("items");
        Assert.True(items[1].GetProperty("checked").GetBoolean());
        Assert.NotNull(res.Headers.ETag);

        var disk = await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "chores"));
        Assert.Contains("- [x] bins", disk);
        Assert.Contains("- [ ] dishes", disk);
        Assert.Contains("kind: todo", disk);

        // The write is a proper one: the note on the desk shows it, and the version before it is in History.
        var desk = await app.Client.GetFromJsonAsync<List<Note>>("/api/notes");
        Assert.Contains("- [x] bins", desk!.Single(n => n.Id == "chores").Body);
        var versions = await app.Client.GetFromJsonAsync<JsonElement>("/api/notes/chores/snapshots");
        Assert.True(versions.GetArrayLength() >= 1);

        // Untick it again.
        Assert.Equal(HttpStatusCode.OK, (await Tick(app.Client, "chores", 1, "bins", false)).StatusCode);
        Assert.Contains("- [ ] bins", await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "chores")));
    });

    [Fact]
    public Task AStaleTick_Gets409WithTheListAsItIsNow() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "chores", "Chores", "- [ ] dishes\n- [ ] bins");
        await MakeTodo(app.Client, "chores", "Chores", "- [ ] dishes"); // "bins" was removed elsewhere
        var res = await Tick(app.Client, "chores", 1, "bins", true);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var json = await Json(res);
        Assert.Equal("stale", json.GetProperty("code").GetString());
        Assert.Equal(1, json.GetProperty("items").GetArrayLength());
        Assert.DoesNotContain("[x]", await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "chores")));
    });

    [Fact]
    public Task TwoTicksAtOnce_BothLand() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "chores", "Chores", "- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d");
        var results = await Task.WhenAll(
            Tick(app.Client, "chores", 0, "a", true), Tick(app.Client, "chores", 1, "b", true),
            Tick(app.Client, "chores", 2, "c", true), Tick(app.Client, "chores", 3, "d", true));
        foreach (var r in results) Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var disk = await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "chores"));
        Assert.Equal(4, System.Text.RegularExpressions.Regex.Matches(disk, @"\[x\]").Count);
    });

    [Fact]
    public Task TheEmbedReference_ResolvesThroughTheBlocksRoute() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "chores", "Chores", "Intro\n\n- [ ] dishes\n- [x] bins");
        var res = await Json(await app.Client.GetAsync("/api/notes/chores/blocks/checklist"));
        Assert.Equal("- [ ] dishes\n- [x] bins", res.GetProperty("text").GetString());
        // A plain note has no checklist block of that name.
        await app.Client.PutAsJsonAsync("/api/notes/plain", new NoteWrite("Plain", null, null, false, false, "- [ ] a"));
        Assert.Equal(HttpStatusCode.NotFound, (await app.Client.GetAsync("/api/notes/plain/blocks/checklist")).StatusCode);
    });

    [Fact]
    public Task Refusals_LockedTrashedMissingAndKeys() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "locked", "Locked list", "- [ ] secret thing", secure: true);
        var locked = await Tick(app.Client, "locked", 0, "secret thing", true);
        Assert.Equal(HttpStatusCode.Unauthorized, locked.StatusCode);
        Assert.Equal("locked", (await Json(locked)).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.Client.GetAsync("/api/notes/locked/checklist")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.Client.GetAsync("/api/notes/locked/blocks/checklist")).StatusCode);

        await MakeTodo(app.Client, "bin", "Binned", "- [ ] old");
        await app.Client.PostAsync("/api/notes/bin/trash", null);
        Assert.Equal(HttpStatusCode.NotFound, (await Tick(app.Client, "bin", 0, "old", true)).StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await Tick(app.Client, "nothing-here", 0, "x", true)).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Tick(app.Client, "locked", 0, "", true)).StatusCode);

        await MakeTodo(app.Client, "mine", "Mine", "- [ ] a");
        var key = KeyClient(app, await NewKeyAsync(app, "notes"));
        Assert.Equal(HttpStatusCode.Forbidden, (await Tick(key, "mine", 0, "a", true)).StatusCode);
        Assert.DoesNotContain("[x]", await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "mine")));
    });

    [Fact]
    public Task ATodoThatIsNotYours_IsNotReachable() => WithAppAsync(async app =>
    {
        await MakeTodo(app.Client, "chores", "Chores", "- [ ] dishes");
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", "hunter2!", Role: "User"));
        var bea = app.Factory.CreateClient();
        await bea.LoginAsync("bea", "hunter2!");
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");
        Assert.Equal(HttpStatusCode.NotFound, (await Tick(bea, "chores", 0, "dishes", true)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync("/api/notes/chores/checklist")).StatusCode);
        Assert.DoesNotContain("[x]", await File.ReadAllTextAsync(NoteFiles.Find(app.Notes, "chores")));
    });

    // ── Open live elsewhere ─────────────────────────────────────────────────────

    private sealed class RoomEngine : ICollabEngine
    {
        public CollabStatus Status => CollabStatus.Ok;
        public Uri? BaseUrl => new("http://127.0.0.1:1/");
        public string Secret => "test-collab-secret-0123456789abcdef0123456789abcdef";
        public TimeSpan TicketLifetime => TimeSpan.FromSeconds(60);
        public ConcurrentQueue<(string Room, string BaseHash, string Body, CollabAgent Agent)> Edits { get; } = new();
        public Task<bool> IsRoomActiveAsync(string ownerUid, string noteId, CancellationToken ct = default) => Task.FromResult(noteId == "chores");
        public Task KickAsync(string ownerUid, string noteId, int uid, CancellationToken ct = default) => Task.CompletedTask;
        public Task CloseAsync(string ownerUid, string noteId, bool flush, CancellationToken ct = default) => Task.CompletedTask;
        public Task ExternalChangeAsync(string ownerUid, string noteId, string body, CancellationToken ct = default) => Task.CompletedTask;
        public Task FlushAsync(string ownerUid, string noteId, CancellationToken ct = default) => Task.CompletedTask;
        public Task RestoreAsync(string ownerUid, string noteId, string body, CancellationToken ct = default) => Task.CompletedTask;
        public Task<AgentEditOutcome?> AgentEditAsync(string ownerUid, string noteId, string baseHash, string body, CollabAgent agent, CancellationToken ct = default)
        {
            Edits.Enqueue(($"{ownerUid}:{noteId}", baseHash, body, agent));
            return Task.FromResult<AgentEditOutcome?>(new AgentEditOutcome(AgentEditOutcome.Applied, null, null, false));
        }
    }

    [Fact]
    public async Task ATodoOpenLiveElsewhere_GetsTheTickMergedIntoItsRoom_NotAPlainWrite()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-checklist-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var engine = new RoomEngine();
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.ConfigureTestServices(s => s.AddSingleton<ICollabEngine>(engine));
        });
        try
        {
            var client = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest("admin", "Admin", "a@b.c", "hunter2!"))).StatusCode);
            // While a room is live a plain body write is refused (409 collab_active), so create the list before it "opens".
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/notes/chores",
                new NoteWrite("Chores", null, null, false, false, "- [ ] dishes\n- [ ] bins", Kind: "todo"))).StatusCode);

            var res = await Tick(client, "chores", 0, "dishes", true);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var edit = Assert.Single(engine.Edits);
            Assert.Equal("1:chores", edit.Room);
            Assert.Equal("- [x] dishes\n- [ ] bins", edit.Body);
            Assert.Equal(CollabHash.Of("- [ ] dishes\n- [ ] bins"), edit.BaseHash);
            Assert.Equal("admin", edit.Agent.Username);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }
}
