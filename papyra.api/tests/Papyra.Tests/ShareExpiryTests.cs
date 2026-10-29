using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// A person share with an expiry stops working the moment it expires — not at the
// next cleanup sweep. Every route a recipient can reach a note by must say so,
// the card must stay (empty) so the recipient can see it ended and clear it, and
// passing a note on can never outlast the access doing the passing.
public sealed class ShareExpiryTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-expiry-" + Guid.NewGuid().ToString("N"));
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

    private static async Task<HttpClient> UserAsync(WebApplicationFactory<Program> factory, HttpClient admin, string username)
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"))).StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    // Owner "admin" with note n1, shared with "guest" at `access`, ending `endsIn` from now.
    private static async Task<(HttpClient Owner, HttpClient Guest, int ShareId)> ShareAsync(
        WebApplicationFactory<Program> factory, string access, TimeSpan? endsIn)
    {
        var owner = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await owner.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw))).StatusCode);
        await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Trip plan", null, null, false, false, "the owner's words"));
        var guest = await UserAsync(factory, owner, "guest");
        var res = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: "guest",
            ExpiresUtc: endsIn is { } span ? DateTime.UtcNow + span : null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (owner, guest, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task ASharePastItsExpiry_CannotBeCreated()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, _, _) = await ShareAsync(factory, "view", TimeSpan.FromHours(1));
            foreach (var kind in new[] { "user", "link" })
            {
                var res = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
                    Kind: kind, Access: "view", GranteeUsername: kind == "user" ? "guest" : null,
                    ExpiresUtc: DateTime.UtcNow.AddMinutes(-1), MaxViews: null));
                Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            }
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AShareThatHasNotExpired_StillWorks()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (_, guest, shareId) = await ShareAsync(factory, "edit", TimeSpan.FromHours(1));

            var read = await guest.GetAsync($"/api/shares/incoming/{shareId}");
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
            Assert.Equal("the owner's words", (await read.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("body").GetString());
            Assert.Equal(HttpStatusCode.NoContent,
                (await guest.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite("edited"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnExpiredShare_RefusesEveryRouteIntoTheNote()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId) = await ShareAsync(factory, "edit", TimeSpan.FromHours(1));
            await ShareClock.ExpireGrantAsync(factory, shareId);
            var at = $"/api/shares/incoming/{shareId}";

            var read = await guest.GetAsync(at);
            Assert.Equal(HttpStatusCode.Gone, read.StatusCode);
            Assert.Equal("share_expired", (await read.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

            Assert.Equal(HttpStatusCode.Gone, (await guest.PutAsJsonAsync(at, new SharedBodyWrite("overwritten"))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.PutAsJsonAsync(at, new SharedBodyWrite(null, "Renamed"))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.PutAsJsonAsync($"{at}/color", new SharedColorWrite("#ff0000"))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.PutAsJsonAsync($"{at}/pin", new SharedPinWrite(true))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.PutAsJsonAsync($"{at}/tags", new SharedTagsWrite(["x"]))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.PostAsJsonAsync($"{at}/share", new ReshareWrite("admin", "view"))).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.GetAsync($"{at}/link?target=Trip%20plan")).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await guest.GetAsync($"{at}/media/a.png")).StatusCode);
            Assert.Equal(HttpStatusCode.Gone,
                (await guest.PostAsync($"{at}/media/upload", new MultipartFormDataContent())).StatusCode);

            // And nothing it tried got through.
            var note = (await owner.GetFromJsonAsync<JsonElement>("/api/notes"))
                .EnumerateArray().Single(n => n.GetProperty("id").GetString() == "n1");
            Assert.Equal("the owner's words", note.GetProperty("body").GetString());
            Assert.Equal("Trip plan", note.GetProperty("title").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnExpiredShare_ShowsAsAnEmptyCard_ThatCarriesNothingOfTheNote()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (_, guest, shareId) = await ShareAsync(factory, "edit", TimeSpan.FromHours(1));
            await ShareClock.ExpireGrantAsync(factory, shareId);

            var card = (await guest.GetFromJsonAsync<JsonElement>("/api/shares/incoming")).EnumerateArray().Single();
            Assert.Equal(shareId, card.GetProperty("shareId").GetInt32());
            Assert.True(card.GetProperty("expired").GetBoolean());
            Assert.Equal("admin", card.GetProperty("owner").GetString());
            foreach (var field in new[] { "title", "body", "excerpt", "noteId" })
                Assert.Equal("", card.GetProperty(field).GetString());
            Assert.Equal(JsonValueKind.Null, card.GetProperty("color").ValueKind);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheRecipient_CanClearAnExpiredShare_ButNotOneThatStillWorks()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId) = await ShareAsync(factory, "view", TimeSpan.FromHours(1));

            Assert.Equal(HttpStatusCode.Conflict, (await guest.DeleteAsync($"/api/shares/incoming/{shareId}")).StatusCode);

            await ShareClock.ExpireGrantAsync(factory, shareId);
            var stranger = await UserAsync(factory, owner, "stranger");
            Assert.Equal(HttpStatusCode.NotFound, (await stranger.DeleteAsync($"/api/shares/incoming/{shareId}")).StatusCode);

            Assert.Equal(HttpStatusCode.NoContent, (await guest.DeleteAsync($"/api/shares/incoming/{shareId}")).StatusCode);
            Assert.Empty((await guest.GetFromJsonAsync<JsonElement>("/api/shares/incoming")).EnumerateArray());
            Assert.Equal(HttpStatusCode.NotFound, (await guest.DeleteAsync($"/api/shares/incoming/{shareId}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APersonWhoseShareEnded_IsNotCountedAsSharedWith_AndTheOwnerIsToldItEnded()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, _, shareId) = await ShareAsync(factory, "view", TimeSpan.FromHours(1));
            await ShareClock.ExpireGrantAsync(factory, shareId);

            var summary = await owner.GetFromJsonAsync<JsonElement>("/api/shares/summary");
            Assert.Empty(summary.EnumerateArray().Single().GetProperty("people").EnumerateArray());

            var listed = (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/shares")).EnumerateArray().Single();
            Assert.True(listed.GetProperty("expired").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SharingAgainWithSomeoneWhoseShareEnded_StartsAFreshOne()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId) = await ShareAsync(factory, "view", TimeSpan.FromHours(1));
            await ShareClock.ExpireGrantAsync(factory, shareId);
            Assert.Equal(HttpStatusCode.Gone, (await guest.GetAsync($"/api/shares/incoming/{shareId}")).StatusCode);

            var again = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "guest", ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
            Assert.Equal(shareId, (await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32());

            Assert.Equal(HttpStatusCode.OK, (await guest.GetAsync($"/api/shares/incoming/{shareId}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task APassedOnShare_NeverOutlastsTheOneThatPassedItOn()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId) = await ShareAsync(factory, "edit", TimeSpan.FromHours(1));
            await UserAsync(factory, owner, "cara");

            var passed = await guest.PostAsJsonAsync($"/api/shares/incoming/{shareId}/share", new ReshareWrite("cara", "view"));
            Assert.Equal(HttpStatusCode.OK, passed.StatusCode);

            var rows = (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/shares")).EnumerateArray().ToList();
            var cara = rows.Single(r => r.GetProperty("grantee").GetString() == "cara");
            var guestRow = rows.Single(r => r.GetProperty("grantee").GetString() == "guest");
            Assert.Equal(JsonValueKind.String, cara.GetProperty("expiresUtc").ValueKind);
            Assert.Equal(guestRow.GetProperty("expiresUtc").GetDateTime(), cara.GetProperty("expiresUtc").GetDateTime());
            Assert.Equal("guest", cara.GetProperty("sharedBy").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnOwnersShareWithNoExpiry_PassesOnWithNoExpiry()
    {
        var (factory, dir) = NewApp();
        try
        {
            var (owner, guest, shareId) = await ShareAsync(factory, "edit", endsIn: null);
            await UserAsync(factory, owner, "cara");

            Assert.Equal(HttpStatusCode.OK,
                (await guest.PostAsJsonAsync($"/api/shares/incoming/{shareId}/share", new ReshareWrite("cara", "view"))).StatusCode);

            var cara = (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/shares")).EnumerateArray()
                .Single(r => r.GetProperty("grantee").GetString() == "cara");
            Assert.Equal(JsonValueKind.Null, cara.GetProperty("expiresUtc").ValueKind);
        }
        finally { Cleanup(factory, dir); }
    }
}
