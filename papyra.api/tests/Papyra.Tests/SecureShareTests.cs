using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// A locked note's body is withheld until a biometric unlock. Sharing is another
/// read path, and it used to hand the body over in full — to a named sharee, to
/// anyone holding a public link, and to an editor on either. These tests are the
/// fence.
/// </summary>
public sealed class SecureShareTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-share-" + Guid.NewGuid().ToString("N"));
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
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(
        WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, Pw))).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static Task<HttpResponseMessage> WriteNoteAsync(
        HttpClient client, string id, string body, bool secure) =>
        client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: "Bank", Tags: null, Color: null, Pinned: false, Archived: false,
            Body: body, Kind: null, Secure: secure));

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task ALockedNoteCannotBeSharedAtAll()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "s1", "sort code 00-00-00", secure: true);

            var toUser = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.BadRequest, toUser.StatusCode);

            var toLink = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.BadRequest, toLink.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LockingAfterSharingTakesTheNoteBack()
    {
        // The dangerous order: share first, lock second. The share row still
        // exists, so every read path has to check the note, not the row.
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "s1", "the plain version", secure: false);

            var shared = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "edit", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.OK, shared.StatusCode);
            var shareId = (await shared.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

            // Visible while it is an ordinary note.
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync($"/api/shares/incoming/{shareId}")).StatusCode);

            await WriteNoteAsync(owner, "s1", "sort code 00-00-00", secure: true);

            var read = await bea.GetAsync($"/api/shares/incoming/{shareId}");
            Assert.Equal(HttpStatusCode.Gone, read.StatusCode);

            // And it is gone from the list, not merely unreadable by id.
            var list = await bea.GetFromJsonAsync<JsonElement>("/api/shares/incoming");
            Assert.Empty(list.EnumerateArray());

            // An edit-access sharee cannot write over it either: their editor was
            // handed nothing, so a save would erase the note.
            var edit = await bea.PutAsJsonAsync($"/api/shares/incoming/{shareId}",
                new SharedBodyWrite("wiped"));
            Assert.Equal(HttpStatusCode.Gone, edit.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APublicLinkStopsWorkingWhenTheNoteIsLocked()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteNoteAsync(owner, "s1", "the plain version", secure: false);

            var shared = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: 5));
            var token = (await shared.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();

            var anonymous = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await anonymous.GetAsync($"/api/shared/{token}")).StatusCode);

            await WriteNoteAsync(owner, "s1", "sort code 00-00-00", secure: true);

            var read = await anonymous.GetAsync($"/api/shared/{token}");
            Assert.Equal(HttpStatusCode.Gone, read.StatusCode);
            Assert.DoesNotContain("sort code", await read.Content.ReadAsStringAsync());

            // A refused read must not spend one of the link's limited views.
            var shares = await owner.GetFromJsonAsync<JsonElement>("/api/notes/s1/shares");
            Assert.Equal(1, shares.EnumerateArray().First().GetProperty("viewCount").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SharingWithTheSamePersonTwiceReusesTheOneGrant()
    {
        // A mention offers to share, and the same name can be typed again in the
        // next paragraph. Two rows for one piece of access would make revoking
        // look broken.
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "s1", "hello @bea", secure: false);

            var first = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            var second = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.OK, second.StatusCode);

            var firstId = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
            var secondId = (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
            Assert.Equal(firstId, secondId);

            var shares = await owner.GetFromJsonAsync<JsonElement>("/api/notes/s1/shares");
            Assert.Single(shares.EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheSummaryNamesWhoCanSeeEachNote()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await MemberAsync(factory, owner, "bea");
            await MemberAsync(factory, owner, "cleo");
            await WriteNoteAsync(owner, "s1", "shared twice", secure: false);
            await WriteNoteAsync(owner, "s2", "link only", secure: false);
            await WriteNoteAsync(owner, "s3", "private", secure: false);

            foreach (var who in new[] { "bea", "cleo" })
                await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                    Kind: "user", Access: "view", GranteeUsername: who, ExpiresUtc: null, MaxViews: null));
            await owner.PostAsJsonAsync("/api/notes/s2/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: null));

            var summary = await owner.GetFromJsonAsync<JsonElement>("/api/shares/summary");
            var rows = summary.EnumerateArray().ToDictionary(r => r.GetProperty("noteId").GetString()!);

            // A note nobody can see is absent, not present with zeroes — the card
            // renders on the presence of a row.
            Assert.False(rows.ContainsKey("s3"));

            var s1 = rows["s1"];
            Assert.Equal(["bea", "cleo"], s1.GetProperty("people").EnumerateArray().Select(p => p.GetString()));
            Assert.Equal(0, s1.GetProperty("links").GetInt32());

            var s2 = rows["s2"];
            Assert.Empty(s2.GetProperty("people").EnumerateArray());
            Assert.Equal(1, s2.GetProperty("links").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheSummaryDoesNotCountALinkThatNoLongerWorks()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteNoteAsync(owner, "s1", "hello", secure: false);

            await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null,
                ExpiresUtc: DateTime.UtcNow.AddHours(-1), MaxViews: null));

            var summary = await owner.GetFromJsonAsync<JsonElement>("/api/shares/summary");
            var row = summary.EnumerateArray().Single();
            // The row exists (the share is still on file) but an expired link is
            // not access anyone has — saying "1 link" would be a false alarm.
            Assert.Equal(0, row.GetProperty("links").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheSummaryOnlyEverDescribesTheCallersOwnNotes()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "s1", "mine", secure: false);
            await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));

            // Bea can read the note, but the summary is about what she has shared,
            // not what has been shared with her.
            var summary = await bea.GetFromJsonAsync<JsonElement>("/api/shares/summary");
            Assert.Empty(summary.EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AskingForEditOnAnExistingViewShareUpgradesIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "s1", "hello", secure: false);

            await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            var upgraded = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "edit", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));

            Assert.Equal("edit", (await upgraded.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("access").GetString());

            // Never the other way: asking for view again must not take edit away.
            var back = await owner.PostAsJsonAsync("/api/notes/s1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            Assert.Equal("edit", (await back.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("access").GetString());
        }
        finally { Cleanup(factory, dir); }
    }
}
