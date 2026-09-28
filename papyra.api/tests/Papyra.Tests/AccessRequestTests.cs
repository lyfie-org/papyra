using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

/// <summary>
/// "Request edit access": a read-only sharee asks, the owner approves or
/// declines. A request must be anchored to a share or mention the requester
/// already holds, so it can never be used to discover someone else's notes.
/// </summary>
public sealed class AccessRequestTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-access-" + Guid.NewGuid().ToString("N"));
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

    [Fact]
    public async Task AReadOnlySharee_CanRequestEdit_AndApprovalUpgradesTheShare()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");

            var ask = await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            Assert.Equal(HttpStatusCode.OK, ask.StatusCode);

            // Visible to the requester as pending, so the button can say so.
            var mine = await bea.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{shareId}");
            Assert.True(mine.GetProperty("requestPending").GetBoolean());

            // Asking twice is the same request, not a second ping.
            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            var waiting = await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/incoming");
            var only = Assert.Single(waiting.EnumerateArray());
            Assert.Equal("bea", only.GetProperty("requester").GetString());
            Assert.Equal("edit", only.GetProperty("access").GetString());
            Assert.Equal("view", only.GetProperty("currentAccess").GetString());

            var approve = await owner.PostAsJsonAsync(
                $"/api/access-requests/{only.GetProperty("id").GetInt32()}/approve", new AccessDecision(null));
            Assert.Equal(HttpStatusCode.OK, approve.StatusCode);

            var now = await bea.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{shareId}");
            Assert.Equal("edit", now.GetProperty("access").GetString());
            Assert.False(now.GetProperty("requestPending").GetBoolean());
            Assert.True(
                (await bea.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite("our plan"))).IsSuccessStatusCode);
            Assert.Empty((await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/incoming")).EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Declining_LeavesTheShareReadOnly_AndTheRequesterMayAskAgain()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");

            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            var id = (await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/incoming"))
                .EnumerateArray().Single().GetProperty("id").GetInt32();

            Assert.Equal(HttpStatusCode.NoContent, (await owner.PostAsync($"/api/access-requests/{id}/deny", null)).StatusCode);
            // Answered once; a second answer is a conflict, not a silent flip.
            Assert.Equal(HttpStatusCode.Conflict,
                (await owner.PostAsJsonAsync($"/api/access-requests/{id}/approve", new AccessDecision(null))).StatusCode);

            var now = await bea.GetFromJsonAsync<JsonElement>($"/api/shares/incoming/{shareId}");
            Assert.Equal("view", now.GetProperty("access").GetString());
            Assert.False(now.GetProperty("requestPending").GetBoolean());
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bea.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite("x"))).StatusCode);

            Assert.Equal(HttpStatusCode.OK,
                (await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ARequestNeedsAShareOrMentionTheRequesterHolds()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            var cal = await MemberAsync(factory, owner, "cal");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");

            // Cal cannot ride on Bea's share, nor guess an inbox entry.
            Assert.Equal(HttpStatusCode.NotFound,
                (await cal.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await cal.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(null, 999, "edit"))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await cal.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(null, null, "edit"))).StatusCode);

            // Nor can anyone approve a request that isn't theirs to answer.
            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            var id = (await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/incoming"))
                .EnumerateArray().Single().GetProperty("id").GetInt32();
            Assert.Equal(HttpStatusCode.NotFound,
                (await bea.PostAsJsonAsync($"/api/access-requests/{id}/approve", new AccessDecision("edit"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AlreadyHoldingEdit_IsAConflict_AndSharingAsEditorSettlesAPendingRequest()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "the plan");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");

            await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"));
            // The owner upgrades from the share dialog instead of the inbox: same yes.
            await ShareAsync(owner, "n1", "bea", "edit");
            Assert.Empty((await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/incoming")).EnumerateArray());

            Assert.Equal(HttpStatusCode.Conflict,
                (await bea.PostAsJsonAsync("/api/access-requests", new AccessRequestWrite(shareId, null, "edit"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
