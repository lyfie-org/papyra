using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// A sharee with edit access renames the note as well as editing its text, and
// any sharee (view or edit) can pin it on their own desk without touching the
// owner's pin.
public sealed class SharedNoteAccessTests
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

    // Owner "admin" with note `n1`, shared with "guest" at `access`; returns both
    // signed-in clients and the share id.
    private static async Task<(HttpClient Owner, HttpClient Guest, int ShareId, string OwnerUid)> ShareAsync(
        WebApplicationFactory<Program> factory, string access)
    {
        var owner = factory.CreateClient();
        var setup = await owner.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        var ownerUid = (await setup.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32().ToString();

        await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
            Title: "Trip plan", Tags: null, Color: null, Pinned: false, Archived: false, Body: "the owner's words"));
        var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: "guest", Name: "Guest", Email: "g@b.c", Password: "hunter2!", Role: "User"));
        Assert.Equal(HttpStatusCode.OK, provision.StatusCode);
        var shareRes = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: "guest", ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, shareRes.StatusCode);
        var share = await shareRes.Content.ReadFromJsonAsync<ShareDto>();

        var guest = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await guest.LoginAsync("guest", "hunter2!")).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(guest, "hunter2!");
        return (owner, guest, share!.Id, ownerUid);
    }

    private static async Task<JsonElement> OwnerNoteAsync(HttpClient owner)
    {
        var list = await owner.GetFromJsonAsync<JsonElement>("/api/notes");
        return list.EnumerateArray().Single(n => n.GetProperty("id").GetString() == "n1");
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        Directory.Delete(dir, recursive: true);
    }

    [Fact]
    public async Task AnEditor_RenamesTheNote_AndTheBodyIsKept()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId, _) = await ShareAsync(factory, "edit");

            var rename = await guest.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite(null, "Japan trip"));
            Assert.Equal(HttpStatusCode.NoContent, rename.StatusCode);

            var note = await OwnerNoteAsync(owner);
            Assert.Equal("Japan trip", note.GetProperty("title").GetString());
            // A title-only change never touches the text.
            Assert.Equal("the owner's words", note.GetProperty("body").GetString());

            var seen = await guest.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{shareId}");
            Assert.Equal("Japan trip", seen.GetProperty("title").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AViewer_CannotRename()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId, _) = await ShareAsync(factory, "view");
            var rename = await guest.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite(null, "Mine now"));
            Assert.Equal(HttpStatusCode.Forbidden, rename.StatusCode);
            var note = await OwnerNoteAsync(owner);
            Assert.Equal("Trip plan", note.GetProperty("title").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Theory]
    [InlineData("view")]
    [InlineData("edit")]
    public async Task ASharee_PinsOnTheirOwnDeskOnly(string access)
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId, _) = await ShareAsync(factory, access);

            var pin = await guest.PutAsJsonAsync($"/api/shares/incoming/{shareId}/pin", new SharedPinWrite(true));
            Assert.Equal(HttpStatusCode.OK, pin.StatusCode);

            var incoming = await guest.GetFromJsonAsync<JsonElement>("/api/shares/incoming");
            var row = Assert.Single(incoming.EnumerateArray());
            Assert.True(row.GetProperty("pinned").GetBoolean());

            // The owner's note is not pinned by someone else's pin.
            var note = await OwnerNoteAsync(owner);
            Assert.False(note.GetProperty("pinned").GetBoolean());

            await guest.PutAsJsonAsync($"/api/shares/incoming/{shareId}/pin", new SharedPinWrite(false));
            incoming = await guest.GetFromJsonAsync<JsonElement>("/api/shares/incoming");
            Assert.False(Assert.Single(incoming.EnumerateArray()).GetProperty("pinned").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NobodyElse_CanPinYourShare()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, _, shareId, _) = await ShareAsync(factory, "view");
            // The owner is not the grantee of their own share.
            var pin = await owner.PutAsJsonAsync($"/api/shares/incoming/{shareId}/pin", new SharedPinWrite(true));
            Assert.Equal(HttpStatusCode.NotFound, pin.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
