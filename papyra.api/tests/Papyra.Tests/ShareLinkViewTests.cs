using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// A limited-view link counts visits, not requests: the reported bug was a
// "view once" link that died on its own first visit, because the page loaded
// twice (a service-worker reload) and each load spent a view.
public sealed class ShareLinkViewTests
{
    [Fact]
    public async Task OneViewLink_SurvivesAReloadInTheSameVisit_ButNotASecondVisitor()
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
            Assert.Equal(HttpStatusCode.OK, (await visitor.GetAsync($"/api/shared/{token}")).StatusCode);
            // Same visit, loaded again: still readable, not counted twice.
            Assert.Equal(HttpStatusCode.OK, (await visitor.GetAsync($"/api/shared/{token}")).StatusCode);

            // Someone else: the one view is spent.
            var stranger = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Gone, (await stranger.GetAsync($"/api/shared/{token}")).StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
