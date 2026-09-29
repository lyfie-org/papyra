using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

/// <summary>
/// Comments on notes: threads anchored to a passage, replies, @mentions,
/// reactions, resolve. Anyone who can see a note can comment; nobody else can
/// even learn a note's comments exist.
/// </summary>
public sealed class CommentTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-comments-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task<HttpClient> OwnerAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"))).StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static async Task<int> ShareAsync(HttpClient owner, string noteId, string who, string access)
    {
        var res = await owner.PostAsJsonAsync($"/api/notes/{noteId}/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: who, ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<int> PostAsync(HttpClient client, string query, object body)
    {
        var res = await client.PostAsJsonAsync($"/api/comments?{query}", body);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static async Task<JsonElement> ThreadsAsync(HttpClient client, string query) =>
        (await client.GetFromJsonAsync<JsonElement>($"/api/comments?{query}")).GetProperty("threads");

    [Fact]
    public async Task AViewer_CanComment_TheOwnerReplies_AndBothSeeOneThread()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await owner.PutAsJsonAsync("/api/notes/plan", new NoteWrite("Plan", null, null, false, false, "Ship the beta on Friday."));
            var bea = await MemberAsync(factory, owner, "bea");
            var shareId = await ShareAsync(owner, "plan", "bea", "view");

            var root = await PostAsync(bea, $"share={shareId}", new
            {
                body = "Is Friday realistic, @owner?",
                quote = new { exact = "on Friday", prefix = "Ship the beta ", suffix = "." },
            });
            await PostAsync(owner, "note=plan", new { body = "Yes — QA signed off.", threadId = root });

            var threads = await ThreadsAsync(bea, $"share={shareId}");
            var thread = threads.EnumerateArray().Single();
            Assert.Equal("on Friday", thread.GetProperty("quote").GetProperty("exact").GetString());
            Assert.Equal(["bea", "owner"], thread.GetProperty("comments").EnumerateArray()
                .Select(c => c.GetProperty("author").GetProperty("username").GetString()!).ToArray());
            // The viewer started it, so may resolve it; the owner may delete anything.
            Assert.True(thread.GetProperty("canResolve").GetBoolean());
            Assert.Single((await ThreadsAsync(owner, "note=plan")).EnumerateArray());

            // The owner heard about the mention; bea heard about the reply.
            var ownerTray = await owner.GetFromJsonAsync<JsonElement>("/api/notifications");
            var mention = ownerTray.EnumerateArray().Single(n => n.GetProperty("kind").GetString() == "comment_mention");
            Assert.Equal("Is Friday realistic, @owner?", mention.GetProperty("text").GetString());
            Assert.Equal(root, mention.GetProperty("threadId").GetInt32());
            var beaTray = await bea.GetFromJsonAsync<JsonElement>("/api/notifications");
            Assert.Contains(beaTray.EnumerateArray(), n => n.GetProperty("kind").GetString() == "comment_reply");
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SomeoneWithoutAccess_CannotReadOrPost()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await owner.PutAsJsonAsync("/api/notes/secret", new NoteWrite("Secret", null, null, false, false, "Mine."));
            await PostAsync(owner, "note=secret", new { body = "Note to self" });
            var cal = await MemberAsync(factory, owner, "cal");

            // cal's own vault has no note "secret"; someone else's share id is not theirs.
            Assert.Equal(HttpStatusCode.NotFound, (await cal.GetAsync("/api/comments?note=secret")).StatusCode);
            var bea = await MemberAsync(factory, owner, "bea");
            var beaShare = await ShareAsync(owner, "secret", "bea", "view");
            Assert.Equal(HttpStatusCode.NotFound, (await cal.GetAsync($"/api/comments?share={beaShare}")).StatusCode);

            // Nor act on a comment by id.
            var id = (await ThreadsAsync(bea, $"share={beaShare}")).EnumerateArray().Single().GetProperty("id").GetInt32();
            Assert.Equal(HttpStatusCode.NotFound, (await cal.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "👍" })).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await cal.DeleteAsync($"/api/comments/{id}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Reactions_Toggle_AndOnlyTheStandardSetIsAccepted()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await owner.PutAsJsonAsync("/api/notes/n", new NoteWrite("N", null, null, false, false, "Body"));
            var id = await PostAsync(owner, "note=n", new { body = "First" });

            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "👍" })).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "❤️" })).StatusCode);
            var reactions = (await ThreadsAsync(owner, "note=n")).EnumerateArray().Single()
                .GetProperty("comments")[0].GetProperty("reactions");
            Assert.Equal(["👍", "❤️"], reactions.EnumerateArray().Select(r => r.GetProperty("emoji").GetString()!).ToArray());
            Assert.True(reactions[0].GetProperty("mine").GetBoolean());

            // Again takes it back.
            await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "👍" });
            reactions = (await ThreadsAsync(owner, "note=n")).EnumerateArray().Single().GetProperty("comments")[0].GetProperty("reactions");
            Assert.Single(reactions.EnumerateArray());

            Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync($"/api/comments/{id}/reactions", new { emoji = "<script>" })).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OnlyTheAuthorEdits_TheOwnerModerates_AndResolvingIsForEditors()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await owner.PutAsJsonAsync("/api/notes/n", new NoteWrite("N", null, null, false, false, "Body text"));
            var bea = await MemberAsync(factory, owner, "bea");
            var cal = await MemberAsync(factory, owner, "cal");
            var beaShare = await ShareAsync(owner, "n", "bea", "view");
            var calShare = await ShareAsync(owner, "n", "cal", "view");

            var root = await PostAsync(bea, $"share={beaShare}", new { body = "Typo here", quote = new { exact = "Body" } });
            var reply = await PostAsync(cal, $"share={calShare}", new { body = "Agreed", threadId = root });

            // cal can't edit bea's words, nor (a viewer who didn't start it) resolve the thread.
            Assert.Equal(HttpStatusCode.Forbidden, (await cal.PutAsJsonAsync($"/api/comments/{root}", new { body = "hacked" })).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await cal.PostAsJsonAsync($"/api/comments/{root}/resolve", new { resolved = true })).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await bea.PutAsJsonAsync($"/api/comments/{root}", new { body = "Typo here?" })).StatusCode);

            // The owner resolves; a new reply reopens it.
            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync($"/api/comments/{root}/resolve", new { resolved = true })).StatusCode);
            Assert.True((await ThreadsAsync(owner, "note=n"))[0].GetProperty("resolved").GetBoolean());
            await PostAsync(bea, $"share={beaShare}", new { body = "Still wrong", threadId = root });
            Assert.False((await ThreadsAsync(owner, "note=n"))[0].GetProperty("resolved").GetBoolean());

            // The owner can remove anyone's reply; removing the first comment removes the thread.
            Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/api/comments/{reply}")).StatusCode);
            Assert.Equal(2, (await ThreadsAsync(owner, "note=n"))[0].GetProperty("comments").GetArrayLength());
            Assert.Equal(HttpStatusCode.NoContent, (await bea.DeleteAsync($"/api/comments/{root}")).StatusCode);
            Assert.Empty((await ThreadsAsync(owner, "note=n")).EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }
}
