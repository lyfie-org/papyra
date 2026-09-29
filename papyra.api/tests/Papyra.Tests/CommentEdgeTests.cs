using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

/// <summary>
/// The edges of comments: bad input, threads that don't belong, notes that
/// stop being commentable (locked, trashed, unshared), who hears about what,
/// and what's left behind when things are deleted.
/// </summary>
public sealed class CommentEdgeTests
{
    private const string Pw = "hunter2!";

    private sealed class App : IDisposable
    {
        public WebApplicationFactory<Program> Factory { get; }
        private readonly string _dir;
        public App()
        {
            _dir = Path.Combine(Path.GetTempPath(), "papyra-cedge-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
            Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            {
                b.UseEnvironment("Development");
                b.UseSetting("Papyra:DataDir", _dir);
            });
        }
        public void Dispose()
        {
            Factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(_dir, recursive: true); } catch (IOException) { /* temp dir */ }
        }
    }

    private static async Task<HttpClient> OwnerAsync(App app)
    {
        var client = app.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
        return client;
    }

    private static async Task<(HttpClient Client, int Id)> MemberAsync(App app, HttpClient owner, string username)
    {
        var res = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var id = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        var client = app.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return (client, id);
    }

    private static async Task<int> ShareAsync(HttpClient owner, string noteId, string who, string access)
    {
        var res = await owner.PostAsJsonAsync($"/api/notes/{noteId}/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: who, ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static Task<HttpResponseMessage> Note(HttpClient c, string id, string body = "Some body text here", bool secure = false) =>
        c.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite("T", null, null, false, false, body, Kind: null, Secure: secure));

    private static async Task<int> PostAsync(HttpClient c, string query, object body)
    {
        var res = await c.PostAsJsonAsync($"/api/comments?{query}", body);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    /// <summary>The comment entries in someone's tray (shares announce themselves there too).</summary>
    private static async Task<JsonElement[]> TrayAsync(HttpClient c) =>
        (await c.GetFromJsonAsync<JsonElement>("/api/notifications")).EnumerateArray()
            .Where(n => n.GetProperty("kind").GetString()!.StartsWith("comment")).ToArray();

    [Fact]
    public async Task BadInput_IsRefused()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");

        async Task<HttpStatusCode> Post(object body) => (await owner.PostAsJsonAsync("/api/comments?note=n", body)).StatusCode;
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { body = "" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { body = "   \n  " }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { body = new string('x', 4001) }));
        Assert.Equal(HttpStatusCode.OK, await Post(new { body = new string('x', 4000) }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { body = "ok", quote = new { exact = new string('q', 501) } }));
        // Neither a note nor a share named: nothing to comment on.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync("/api/comments", new { body = "hi" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/api/comments")).StatusCode);
        // A path-ish id never reaches the vault.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/api/comments?note=..%2F..%2Fetc")).StatusCode);
        // A note that doesn't exist.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync("/api/comments?note=ghost", new { body = "hi" })).StatusCode);

        var id = await PostAsync(owner, "note=n", new { body = "root" });
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PutAsJsonAsync($"/api/comments/{id}", new { body = "" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PutAsJsonAsync("/api/comments/99999", new { body = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.DeleteAsync("/api/comments/99999")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = (string?)null })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "🐍" })).StatusCode);
    }

    [Fact]
    public async Task Replies_MustTargetAThreadOnTheSameNote_AndStayOneLevelDeep()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "a");
        await Note(owner, "b");
        var onA = await PostAsync(owner, "note=a", new { body = "on a" });
        var reply = await PostAsync(owner, "note=a", new { body = "reply", threadId = onA });

        // A thread on another note, a reply id, or nothing at all: not a thread here.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync("/api/comments?note=b", new { body = "x", threadId = onA })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync("/api/comments?note=a", new { body = "x", threadId = reply })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync("/api/comments?note=a", new { body = "x", threadId = 424242 })).StatusCode);
        // Only a thread's first comment can be resolved.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync($"/api/comments/{reply}/resolve", new { resolved = true })).StatusCode);

        // A reply ignores any quote it was sent: the passage belongs to the thread.
        await PostAsync(owner, "note=a", new { body = "y", threadId = onA, quote = new { exact = "Some" } });
        var thread = (await owner.GetFromJsonAsync<JsonElement>("/api/comments?note=a")).GetProperty("threads").EnumerateArray().Single();
        Assert.Equal(JsonValueKind.Null, thread.GetProperty("quote").ValueKind);
        Assert.Equal(3, thread.GetProperty("comments").GetArrayLength());
    }

    [Fact]
    public async Task QuoteContext_IsClippedToItsNearEdge()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");
        await PostAsync(owner, "note=n", new
        {
            body = "c",
            quote = new { exact = "body", prefix = new string('p', 100) + "END", suffix = "START" + new string('s', 100) },
        });
        var quote = (await owner.GetFromJsonAsync<JsonElement>("/api/comments?note=n")).GetProperty("threads")[0].GetProperty("quote");
        // The prefix keeps the text just before the passage; the suffix the text just after.
        Assert.Equal(64, quote.GetProperty("prefix").GetString()!.Length);
        Assert.EndsWith("END", quote.GetProperty("prefix").GetString());
        Assert.StartsWith("START", quote.GetProperty("suffix").GetString());
    }

    [Fact]
    public async Task LockedOrTrashedNotes_TakeNoComments()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await TestAuth.SetVaultPinAsync(owner, Pw);
        await Note(owner, "n");
        var id = await PostAsync(owner, "note=n", new { body = "before" });

        Assert.Equal(HttpStatusCode.OK, (await Note(owner, "s", "secret", secure: true)).StatusCode);
        var locked = await owner.PostAsJsonAsync("/api/comments?note=s", new { body = "x", quote = new { exact = "secret" } });
        Assert.Equal(HttpStatusCode.Conflict, locked.StatusCode);
        Assert.Equal("locked", (await locked.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await owner.GetAsync("/api/comments?note=s")).StatusCode);

        Assert.True((await owner.PostAsync("/api/notes/n/trash", null)).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/api/comments?note=n")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "👍" })).StatusCode);
    }

    [Fact]
    public async Task Unsharing_EndsAccess_AndHidesTheWordsFromTheirTray()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");
        var (bea, _) = await MemberAsync(app, owner, "bea");
        var shareId = await ShareAsync(owner, "n", "bea", "view");
        var root = await PostAsync(bea, $"share={shareId}", new { body = "mine" });
        await PostAsync(owner, "note=n", new { body = "secret reply", threadId = root });
        Assert.Contains(await TrayAsync(bea), n => n.GetProperty("text").GetString() == "secret reply");

        Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/api/shares/{shareId}")).StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/comments?share={shareId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsJsonAsync($"/api/comments?share={shareId}", new { body = "x" })).StatusCode);
        // Not even their own comment, by id.
        Assert.Equal(HttpStatusCode.NotFound, (await bea.PutAsJsonAsync($"/api/comments/{root}", new { body = "edit" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bea.DeleteAsync($"/api/comments/{root}")).StatusCode);
        var reply = (await TrayAsync(bea)).Single(n => n.GetProperty("kind").GetString() == "comment_reply");
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("text").ValueKind);
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("threadId").ValueKind);
    }

    [Fact]
    public async Task Notifications_GoToTheRightPeople_Once()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");
        var (bea, _) = await MemberAsync(app, owner, "bea");
        var (cal, _) = await MemberAsync(app, owner, "cal");
        var (dan, _) = await MemberAsync(app, owner, "dan"); // can't see the note
        var beaShare = await ShareAsync(owner, "n", "bea", "edit");
        var calShare = await ShareAsync(owner, "n", "cal", "view");

        // bea mentions cal (in odd case), herself, dan (no access) and the owner.
        var root = await PostAsync(bea, $"share={beaShare}", new { body = "@CAL look, @bea @dan @owner" });
        Assert.Single(await TrayAsync(cal), n => n.GetProperty("kind").GetString() == "comment_mention");
        // The owner was mentioned: one entry, the most specific reason.
        var ownerTray = await TrayAsync(owner);
        Assert.Single(ownerTray);
        Assert.Equal("comment_mention", ownerTray[0].GetProperty("kind").GetString());
        Assert.Empty(await TrayAsync(bea)); // never about your own comment
        Assert.Empty(await TrayAsync(dan));  // can't see the note, hears nothing

        // cal replies: bea (thread) and owner (note) hear; cal doesn't.
        await PostAsync(cal, $"share={calShare}", new { body = "on it" });
        await PostAsync(cal, $"share={calShare}", new { body = "done", threadId = root });
        Assert.Contains(await TrayAsync(bea), n => n.GetProperty("kind").GetString() == "comment_reply");
        Assert.Single(await TrayAsync(cal));

        // An edit-access sharee may resolve someone else's thread.
        Assert.Equal(HttpStatusCode.OK, (await bea.PostAsJsonAsync($"/api/comments/{root}/resolve", new { resolved = true })).StatusCode);
        // Deleting the thread takes its tray entries with it.
        Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/api/comments/{root}")).StatusCode);
        Assert.DoesNotContain(await TrayAsync(cal), n => n.GetProperty("kind").GetString() == "comment_mention");
    }

    [Fact]
    public async Task People_AreWhoCanSeeTheNote_AndMarkupStaysText()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");
        await MemberAsync(app, owner, "bea");
        await MemberAsync(app, owner, "zed");
        await ShareAsync(owner, "n", "bea", "view");
        await PostAsync(owner, "note=n", new { body = "<img src=x onerror=alert(1)>" });

        var data = await owner.GetFromJsonAsync<JsonElement>("/api/comments?note=n");
        var people = data.GetProperty("people").EnumerateArray().Select(p => p.GetProperty("username").GetString()!).OrderBy(x => x).ToArray();
        Assert.Equal(["bea", "owner"], people);
        Assert.Equal("<img src=x onerror=alert(1)>", data.GetProperty("threads")[0].GetProperty("comments")[0].GetProperty("body").GetString());
    }

    [Fact]
    public async Task DeletingAnAccount_RemovesItsCommentsAndTheCommentsOnItsNotes()
    {
        using var app = new App();
        var owner = await OwnerAsync(app);
        await Note(owner, "n");
        var (bea, beaId) = await MemberAsync(app, owner, "bea");
        await Note(bea, "hers");
        var shareId = await ShareAsync(owner, "n", "bea", "view");
        var root = await PostAsync(owner, "note=n", new { body = "owner root" });
        await PostAsync(bea, $"share={shareId}", new { body = "bea reply", threadId = root });
        await bea.PostAsJsonAsync($"/api/comments/{root}/reactions", new { emoji = "🎉" });

        Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/api/auth/users/{beaId}")).StatusCode);

        var thread = (await owner.GetFromJsonAsync<JsonElement>("/api/comments?note=n")).GetProperty("threads").EnumerateArray().Single();
        var comments = thread.GetProperty("comments");
        Assert.Equal(1, comments.GetArrayLength());
        Assert.Empty(comments[0].GetProperty("reactions").EnumerateArray());
    }
}
