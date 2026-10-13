using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Text follows renames: links to a note follow its new title, mentions of a
/// person follow their new username — in every vault and in comments.
/// </summary>
public sealed class RenamePropagationTests
{
    private const string Pw = "hunter2!";

    // ── The text rules ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("See [[Kyoto]].", "See [[Kyoto trip]].")]
    [InlineData("[[kyoto|the city]] and ![[Kyoto#^b1]]", "[[Kyoto trip|the city]] and ![[Kyoto trip#^b1]]")]
    [InlineData("[[Kyoto#Day 2]]", "[[Kyoto trip#Day 2]]")]
    [InlineData("[[Kyoto 2]] stays, [[Kyotoish]] too", "[[Kyoto 2]] stays, [[Kyotoish]] too")]
    [InlineData("`[[Kyoto]]` in code\n```\n[[Kyoto]]\n```\n[[Kyoto]]", "`[[Kyoto]]` in code\n```\n[[Kyoto]]\n```\n[[Kyoto trip]]")]
    public void LinksFollowANewTitle(string body, string expected) =>
        Assert.Equal(expected, TextRenames.RenameLinks(body, "Kyoto", "Kyoto trip"));

    [Fact]
    public void ALinkCantBeMadeToAnUnlinkableTitle() =>
        Assert.Equal("[[Kyoto]]", TextRenames.RenameLinks("[[Kyoto]]", "Kyoto", "Kyoto | Osaka"));

    [Theory]
    [InlineData("Ask @bea.", "Ask @beatrix.")]
    [InlineData("@Bea and (@bea) and [@bea]", "@beatrix and (@beatrix) and [@beatrix]")]
    [InlineData("@bean and @bea.ra and mail@bea", "@bean and @bea.ra and mail@bea")]
    [InlineData("`@bea` stays\n@bea", "`@bea` stays\n@beatrix")]
    public void MentionsFollowANewUsername(string body, string expected) =>
        Assert.Equal(expected, TextRenames.RenameMentions(body, "bea", "beatrix"));

    // ── End to end ─────────────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-renames-" + Guid.NewGuid().ToString("N"));
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

    private static Task<HttpResponseMessage> WriteAsync(HttpClient client, string id, string title, string body) =>
        client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(Title: title, Tags: null, Color: null, Pinned: false,
            Archived: false, Body: body));

    private static async Task<string> BodyAsync(HttpClient client, string id) =>
        (await client.GetFromJsonAsync<JsonElement>($"/api/notes/{id}")).GetProperty("body").GetString()!;

    private static async Task SettledAsync(WebApplicationFactory<Program> factory)
    {
        var renames = factory.Services.GetRequiredService<RenamePropagationService>();
        for (var i = 0; i < 200 && !renames.Idle; i++) await Task.Delay(25);
        Assert.True(renames.Idle, "rename propagation did not finish");
    }

    [Fact]
    public async Task RetitlingANote_RewritesTheLinksToIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "kyoto", "Kyoto", "Temples")).StatusCode);
            await WriteAsync(owner, "plan", "Plan", "Day 2: [[Kyoto]], then [[Kyoto|the old city]] again");
            await WriteAsync(owner, "other", "Other", "Nothing linked");

            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "kyoto", "Kyoto and Nara", "Temples")).StatusCode);
            await SettledAsync(factory);

            Assert.Equal("Day 2: [[Kyoto and Nara]], then [[Kyoto and Nara|the old city]] again", await BodyAsync(owner, "plan"));
            Assert.Equal("Nothing linked", await BodyAsync(owner, "other"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LinksStayWhenAnotherNoteStillHasTheOldTitle()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "a", "Ideas", "one");
            await WriteAsync(owner, "b", "Ideas", "two");
            await WriteAsync(owner, "plan", "Plan", "[[Ideas]]");

            await WriteAsync(owner, "a", "Old ideas", "one");
            await SettledAsync(factory);
            Assert.Equal("[[Ideas]]", await BodyAsync(owner, "plan"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ChangingAUsername_RewritesMentionsEverywhere()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteAsync(owner, "trip", "Trip", "Ask @bea about trains. Not @bean.");
            await WriteAsync(bea, "mine", "Mine", "I am @bea");
            var comment = await owner.PostAsJsonAsync("/api/comments?note=trip", new { body = "@bea can you check?" });
            Assert.Equal(HttpStatusCode.OK, comment.StatusCode);

            var renamed = await bea.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, "beatrix"));
            Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
            await SettledAsync(factory);

            Assert.Equal("Ask @beatrix about trains. Not @bean.", await BodyAsync(owner, "trip"));
            Assert.Equal("I am @beatrix", await BodyAsync(bea, "mine"));
            var threads = (await owner.GetFromJsonAsync<JsonElement>("/api/comments?note=trip")).GetProperty("threads");
            Assert.Contains("@beatrix can you check?", threads.GetRawText());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ARefusedRename_ChangesNoText()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await MemberAsync(factory, owner, "cal");
            await WriteAsync(owner, "trip", "Trip", "Ask @bea");

            Assert.Equal(HttpStatusCode.Conflict,
                (await bea.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, "cal"))).StatusCode);
            await SettledAsync(factory);
            Assert.Equal("Ask @bea", await BodyAsync(owner, "trip"));
        }
        finally { Cleanup(factory, dir); }
    }
}
