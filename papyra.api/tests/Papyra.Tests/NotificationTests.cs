using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

/// <summary>
/// The bell: every cross-user event lands as a notification, and what one may
/// reveal about a note is re-checked against shares on every read.
/// </summary>
public sealed class NotificationTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-notify-" + Guid.NewGuid().ToString("N"));
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
        var setup = await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        await TestAuth.SetVaultPinAsync(client, Pw);
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

    private static Task<HttpResponseMessage> WriteNoteAsync(HttpClient client, string id, string body) =>
        client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: "Plan", Tags: null, Color: null, Pinned: false, Archived: false,
            Body: body, Kind: null, Secure: false));

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

    private static async Task<JsonElement[]> TrayAsync(HttpClient c) =>
        (await c.GetFromJsonAsync<JsonElement>("/api/notifications")).EnumerateArray().ToArray();

    private static async Task<JsonElement[]> WaitForTrayAsync(HttpClient c, int count)
    {
        for (var i = 0; i < 50; i++)
        {
            var tray = await TrayAsync(c);
            if (tray.Length >= count) return tray;
            await Task.Delay(100);
        }
        return await TrayAsync(c);
    }

    [Fact]
    public async Task TheWholeRequestLoop_IsNarratedInBothTrays()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");

            var shared = Assert.Single(await TrayAsync(bea));
            Assert.Equal("shared", shared.GetProperty("kind").GetString());
            Assert.Equal("owner", shared.GetProperty("actor").GetString());
            Assert.Equal("Plan", shared.GetProperty("title").GetString());
            Assert.Equal(shareId, shared.GetProperty("shareId").GetInt32());
            Assert.Equal(JsonValueKind.Null, shared.GetProperty("readUtc").ValueKind);

            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            var asked = Assert.Single(await TrayAsync(owner));
            Assert.Equal("access_requested", asked.GetProperty("kind").GetString());
            Assert.Equal("bea", asked.GetProperty("actor").GetString());
            Assert.Equal("pending", asked.GetProperty("requestStatus").GetString());
            Assert.True(asked.GetProperty("mine").GetBoolean());

            await owner.PostAsJsonAsync($"/api/access-requests/{asked.GetProperty("requestId").GetInt32()}/approve",
                new AccessDecision(null));
            Assert.Equal("approved", Assert.Single(await TrayAsync(owner)).GetProperty("requestStatus").GetString());

            var beaTray = await TrayAsync(bea);
            Assert.Equal("access_approved", beaTray[0].GetProperty("kind").GetString());
            Assert.Equal("edit", beaTray[0].GetProperty("shareAccess").GetString());

            // Opening the tray reads everything; dismissing removes one.
            await bea.PostAsync("/api/notifications/read", null);
            Assert.All(await TrayAsync(bea), n => Assert.NotEqual(JsonValueKind.Null, n.GetProperty("readUtc").ValueKind));
            Assert.Equal(HttpStatusCode.NoContent,
                (await bea.DeleteAsync($"/api/notifications/{beaTray[0].GetProperty("id").GetInt32()}")).StatusCode);
            Assert.Single(await TrayAsync(bea));
            // Not someone else's to dismiss.
            Assert.Equal(HttpStatusCode.NotFound,
                (await owner.DeleteAsync($"/api/notifications/{beaTray[1].GetProperty("id").GetInt32()}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ADecline_TellsTheRequester()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");
            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            var id = (await TrayAsync(owner))[0].GetProperty("requestId").GetInt32();

            await owner.PostAsync($"/api/access-requests/{id}/deny", null);
            var top = (await TrayAsync(bea))[0];
            Assert.Equal("access_denied", top.GetProperty("kind").GetString());
            Assert.Equal("denied", top.GetProperty("requestStatus").GetString());
            Assert.Equal("denied", (await TrayAsync(owner))[0].GetProperty("requestStatus").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AMention_RevealsNothingOfTheNote_UntilItIsShared()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "Could @bea check the hotels?\n\nprivate budget line");

            var mention = Assert.Single(await WaitForTrayAsync(bea, 1));
            Assert.Equal("mention", mention.GetProperty("kind").GetString());
            Assert.Equal(JsonValueKind.Null, mention.GetProperty("title").ValueKind);
            Assert.Equal(JsonValueKind.Null, mention.GetProperty("text").ValueKind);
            Assert.Equal(JsonValueKind.Null, mention.GetProperty("shareId").ValueKind);

            await ShareAsync(owner, "n1", "bea", "edit");
            var after = (await TrayAsync(bea)).Single(n => n.GetProperty("kind").GetString() == "mention");
            Assert.Equal("Plan", after.GetProperty("title").GetString());
            Assert.Equal("Could @bea check the hotels?", after.GetProperty("text").GetString());
        }
        finally { Cleanup(factory, dir); }
    }
}
