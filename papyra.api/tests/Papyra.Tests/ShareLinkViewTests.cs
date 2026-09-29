using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// A limited-view link counts page loads, not requests. The page sends one id
// per load (X-Papyra-View): repeat requests inside that load (a remount, a
// retry) are one view; a reload is a new id and a new view. It used to grant a
// whole hour of free reloads, so a "view once" link could be read indefinitely.
public sealed class ShareLinkViewTests
{
    private static HttpRequestMessage Load(string token, string viewId)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/shared/{token}");
        req.Headers.Add("X-Papyra-View", viewId);
        return req;
    }

    [Fact]
    public async Task OneViewLink_IsOneRequestBurstInOnePageLoad_AndAReloadIsRefused()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-view-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var owner = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await owner.PostSetupAsync(new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"))).StatusCode);
            await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Once", null, null, false, false, "read me once"));
            var created = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: 1));
            var token = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;

            var visitor = factory.CreateClient(); // its own cookie jar
            Assert.Equal(HttpStatusCode.OK, (await visitor.SendAsync(Load(token, "load-1"))).StatusCode);
            // Same page load asking again (a remount): still readable, not counted twice.
            Assert.Equal(HttpStatusCode.OK, (await visitor.SendAsync(Load(token, "load-1"))).StatusCode);

            // A reload in the same browser is a second view.
            Assert.Equal(HttpStatusCode.Gone, (await visitor.SendAsync(Load(token, "load-2"))).StatusCode);
            // So is a bare request, and anyone else.
            Assert.Equal(HttpStatusCode.Gone, (await visitor.GetAsync($"/api/shared/{token}")).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await factory.CreateClient().SendAsync(Load(token, "load-1"))).StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task EveryReload_CountsAView()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-view-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var owner = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await owner.PostSetupAsync(new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"))).StatusCode);
            await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Thrice", null, null, false, false, "read me"));
            var created = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
                Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: 3));
            var token = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;

            var visitor = factory.CreateClient();
            for (var i = 1; i <= 3; i++)
            {
                var res = await visitor.SendAsync(Load(token, $"load-{i}"));
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                var body = await res.Content.ReadFromJsonAsync<JsonElement>();
                Assert.Equal(i, body.GetProperty("views").GetInt32());
            }
            Assert.Equal(HttpStatusCode.Gone, (await visitor.SendAsync(Load(token, "load-4"))).StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    private static async Task<(WebApplicationFactory<Program> Factory, string Dir, HttpClient Owner)> OwnerAppAsync()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-view-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        var owner = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await owner.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"))).StatusCode);
        await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("N", null, null, false, false, "body"));
        return (factory, dir, owner);
    }

    private static async Task<string> LinkAsync(HttpClient owner, int? maxViews, DateTime? expires = null)
    {
        var res = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
            Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: expires, MaxViews: maxViews));
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;
    }

    private static async Task<int> ViewCountAsync(HttpClient owner, string token) =>
        (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/shares")).EnumerateArray()
            .Single(s => s.GetProperty("token").GetString() == token).GetProperty("viewCount").GetInt32();

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task RefusedReads_AndMedia_NeverSpendAView()
    {
        var (factory, dir, owner) = await OwnerAppAsync();
        try
        {
            var expired = await LinkAsync(owner, 1, DateTime.UtcNow.AddMinutes(-1));
            Assert.Equal(HttpStatusCode.Gone, (await factory.CreateClient().SendAsync(Load(expired, "a"))).StatusCode);
            Assert.Equal(0, await ViewCountAsync(owner, expired));

            var once = await LinkAsync(owner, 1);
            // Media is part of the page, not a view.
            await factory.CreateClient().GetAsync($"/api/shared/{once}/media/nothing.png");
            Assert.Equal(0, await ViewCountAsync(owner, once));
            Assert.Equal(HttpStatusCode.NotFound, (await factory.CreateClient().SendAsync(Load("no-such-token", "a"))).StatusCode);

            // Locked after sharing: refused, and the one view is still there to spend.
            await TestAuth.SetVaultPinAsync(owner, "hunter2!");
            await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("N", null, null, false, false, "body", Kind: null, Secure: true));
            Assert.Equal(HttpStatusCode.Gone, (await factory.CreateClient().SendAsync(Load(once, "a"))).StatusCode);
            Assert.Equal(0, await ViewCountAsync(owner, once));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ACookieOnlyExcusesTheLoadItWasIssuedFor()
    {
        var (factory, dir, owner) = await OwnerAppAsync();
        try
        {
            var token = await LinkAsync(owner, null);
            var visitor = factory.CreateClient();
            await visitor.SendAsync(Load(token, "one"));
            await visitor.SendAsync(Load(token, "one"));
            Assert.Equal(1, await ViewCountAsync(owner, token));

            // A forged cookie, or a real one presented with another load's id, is a new view.
            var forged = Load(token, "two");
            forged.Headers.Add("Cookie", "papyra_view_1=forged");
            await factory.CreateClient().SendAsync(forged);
            await visitor.SendAsync(Load(token, "three"));
            Assert.Equal(3, await ViewCountAsync(owner, token));

            // An absurd id is ignored — so every request counts, as with no id at all.
            var huge = new string('x', 65);
            await visitor.SendAsync(Load(token, huge));
            await visitor.SendAsync(Load(token, huge));
            Assert.Equal(5, await ViewCountAsync(owner, token));
        }
        finally { Cleanup(factory, dir); }
    }
}
