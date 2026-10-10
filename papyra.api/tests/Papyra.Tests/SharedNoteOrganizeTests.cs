using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// What a sharee can do with a note shared with them, beyond reading and
// editing it: their own tags (never the owner's), the note's colour (editors —
// colour belongs to the note), passing it on (editors), following its
// [[links]] to other notes shared with them, and one copied link that opens the
// note for whoever holds it.
public sealed class SharedNoteOrganizeTests
{
    private sealed record ShareDto(int Id);

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
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
        Directory.Delete(dir, recursive: true);
    }

    private sealed record World(HttpClient Owner, HttpClient Guest, HttpClient Carol, int ShareId);

    // Owner "admin" with notes n1 "Trip plan" (links to [[Packing list]] and
    // [[Budget]]), n2 "Packing list", n3 "Budget"; n1 shared with "guest" at
    // `access`. "carol" exists and has nothing.
    private static async Task<World> SetUpAsync(WebApplicationFactory<Program> factory, string access)
    {
        var owner = factory.CreateClient();
        var setup = await owner.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Ada Lovelace", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

        await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
            Title: "Trip plan", Tags: ["travel"], Color: null, Pinned: false, Archived: false,
            Body: "See [[Packing list]] and [[Budget]]."));
        await owner.PutAsJsonAsync("/api/notes/n2", new NoteWrite(
            Title: "Packing list", Tags: null, Color: null, Pinned: false, Archived: false, Body: "socks"));
        await owner.PutAsJsonAsync("/api/notes/n3", new NoteWrite(
            Title: "Budget", Tags: null, Color: null, Pinned: false, Archived: false, Body: "¥"));
        foreach (var name in new[] { "guest", "carol" })
        {
            var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: name, Name: name, Email: $"{name}@b.c", Password: "hunter2!", Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);
        }
        var shareRes = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: "guest", ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, shareRes.StatusCode);
        var share = await shareRes.Content.ReadFromJsonAsync<ShareDto>();

        var guest = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await guest.LoginAsync("guest", "hunter2!")).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(guest, "hunter2!");
        var carol = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await carol.LoginAsync("carol", "hunter2!")).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(carol, "hunter2!");
        return new World(owner, guest, carol, share!.Id);
    }

    private static async Task<JsonElement> OwnerNoteAsync(HttpClient owner, string id = "n1")
    {
        var list = await owner.GetFromJsonAsync<JsonElement>("/api/notes");
        return list.EnumerateArray().Single(n => n.GetProperty("id").GetString() == id);
    }

    [Theory]
    [InlineData("view")]
    [InlineData("edit")]
    public async Task ASharee_TagsItForThemselves_AndTheOwnersTagsStay(string access)
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, access);
            var put = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/tags",
                new SharedTagsWrite(["Holidays", " holidays ", "Japan", ""]));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            var row = Assert.Single((await w.Guest.GetFromJsonAsync<JsonElement>("/api/shares/incoming")).EnumerateArray());
            Assert.Equal(["Holidays", "Japan"], row.GetProperty("tags").EnumerateArray().Select(t => t.GetString()));
            var one = await w.Guest.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{w.ShareId}");
            Assert.Equal(2, one.GetProperty("tags").GetArrayLength());

            // The owner's own tags are untouched.
            var note = await OwnerNoteAsync(w.Owner);
            Assert.Equal(["travel"], note.GetProperty("tags").EnumerateArray().Select(t => t.GetString()));

            // Too many is refused, and someone else can't tag your share.
            var many = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/tags",
                new SharedTagsWrite(Enumerable.Range(0, ShareTags.MaxTags + 1).Select(i => $"t{i}").ToList()));
            Assert.Equal(HttpStatusCode.BadRequest, many.StatusCode);
            var stranger = await w.Carol.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/tags", new SharedTagsWrite(["x"]));
            Assert.Equal(HttpStatusCode.NotFound, stranger.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnEditor_ChangesTheNotesColour_AndAViewerCannot()
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "edit");
            var put = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/color", new SharedColorWrite("#f6e2b3"));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
            Assert.Equal("#f6e2b3", (await OwnerNoteAsync(w.Owner)).GetProperty("color").GetString());
            // The body is kept.
            Assert.Equal("See [[Packing list]] and [[Budget]].", (await OwnerNoteAsync(w.Owner)).GetProperty("body").GetString());

            var clear = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/color", new SharedColorWrite(""));
            Assert.Equal(HttpStatusCode.OK, clear.StatusCode);
            Assert.Equal(JsonValueKind.Null, (await OwnerNoteAsync(w.Owner)).GetProperty("color").ValueKind);

            var bad = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/color", new SharedColorWrite("red\n---\ninjected: 1"));
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        }
        finally { Cleanup(factory, dir); }

        (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "view");
            var put = await w.Guest.PutAsJsonAsync($"/api/shares/incoming/{w.ShareId}/color", new SharedColorWrite("#f6e2b3"));
            Assert.Equal(HttpStatusCode.Forbidden, put.StatusCode);
            Assert.Equal(JsonValueKind.Null, (await OwnerNoteAsync(w.Owner)).GetProperty("color").ValueKind);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnEditor_SharesItOnward_AsTheOwnersNote()
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "edit");
            var res = await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("@carol", "view"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("shared", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

            // Carol has it, from the owner, passed on by guest.
            var carols = Assert.Single((await w.Carol.GetFromJsonAsync<JsonElement>("/api/shares/incoming")).EnumerateArray());
            Assert.Equal("admin", carols.GetProperty("owner").GetString());
            Assert.Equal("guest", carols.GetProperty("sharedBy").GetString());
            Assert.Equal("view", carols.GetProperty("access").GetString());
            Assert.Equal("Ada Lovelace", carols.GetProperty("ownerName").GetString());

            // The owner sees the grant and who made it, and can revoke it.
            var list = await w.Owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/shares");
            var row = list.EnumerateArray().Single(s => s.GetProperty("grantee").GetString() == "carol");
            Assert.Equal("guest", row.GetProperty("sharedBy").GetString());

            // Again with edit upgrades; again with view changes nothing.
            var up = await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("carol", "edit"));
            Assert.Equal("upgraded", (await up.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
            var same = await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("carol", "view"));
            Assert.Equal("alreadyShared", (await same.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

            // Not to the owner, not to yourself, not to nobody.
            Assert.Equal(HttpStatusCode.BadRequest, (await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("admin", "view"))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("guest", "view"))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("nobody", "view"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AViewer_CannotShareItOnward()
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "view");
            var res = await w.Guest.PostAsJsonAsync($"/api/shares/incoming/{w.ShareId}/share", new ReshareWrite("carol", "view"));
            Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
            Assert.Empty((await w.Carol.GetFromJsonAsync<JsonElement>("/api/shares/incoming")).EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ALink_OpensTheLinkedNote_OnlyWhenThatOneIsSharedToo()
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "edit");
            // Nothing else shared yet: both links answer "not shared".
            var packing = await w.Guest.GetAsync($"/api/shares/incoming/{w.ShareId}/link?target=Packing%20list");
            Assert.Equal(HttpStatusCode.NotFound, packing.StatusCode);
            var missing = await w.Guest.GetAsync($"/api/shares/incoming/{w.ShareId}/link?target=No%20such%20note");
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

            // The owner shares the packing list (view only).
            var s2 = await w.Owner.PostAsJsonAsync("/api/notes/n2/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "guest", ExpiresUtc: null, MaxViews: null));
            var s2Id = (await s2.Content.ReadFromJsonAsync<ShareDto>())!.Id;

            var found = await w.Guest.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{w.ShareId}/link?target=packing%20LIST");
            Assert.Equal(s2Id, found.GetProperty("shareId").GetInt32());
            Assert.Equal("view", found.GetProperty("access").GetString());
            // The budget still isn't.
            Assert.Equal(HttpStatusCode.NotFound, (await w.Guest.GetAsync($"/api/shares/incoming/{w.ShareId}/link?target=Budget")).StatusCode);
            // Someone without the first share learns nothing.
            Assert.Equal(HttpStatusCode.NotFound, (await w.Carol.GetAsync($"/api/shares/incoming/{w.ShareId}/link?target=Packing%20list")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OneCopiedLink_OpensTheNoteForWhoeverHoldsIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var w = await SetUpAsync(factory, "view");
            var mine = await w.Owner.GetFromJsonAsync<JsonElement>("/api/shares/open?owner=admin&noteId=n1");
            Assert.True(mine.GetProperty("mine").GetBoolean());
            var theirs = await w.Guest.GetFromJsonAsync<JsonElement>("/api/shares/open?owner=admin&noteId=n1");
            Assert.False(theirs.GetProperty("mine").GetBoolean());
            Assert.Equal(w.ShareId, theirs.GetProperty("shareId").GetInt32());
            Assert.Equal(HttpStatusCode.NotFound, (await w.Carol.GetAsync("/api/shares/open?owner=admin&noteId=n1")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await w.Guest.GetAsync("/api/shares/open?owner=admin&noteId=n2")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
