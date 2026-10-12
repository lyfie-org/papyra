using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// Saved collections: created, edited in place (same id, so links keep working), deleted.
public sealed class SmartCollectionEndpointTests
{
    private static string Rules(string field, string value) =>
        JsonSerializer.Serialize(new { match = "all", conditions = new[] { new { field, value } } });

    [Fact]
    public async Task Put_RenamesAndRewritesRules_KeepingTheId()
    {
        await WithAppAsync(async client =>
        {
            var created = await client.PostAsJsonAsync("/api/collections", new { name = "Japan", rulesJson = Rules("tag", "Japan") });
            var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

            var put = await client.PutAsJsonAsync($"/api/collections/{id}", new { name = "  Trips ", rulesJson = Rules("text", "flight") });
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            var all = await client.GetFromJsonAsync<List<JsonElement>>("/api/collections") ?? [];
            var only = Assert.Single(all);
            Assert.Equal(id, only.GetProperty("id").GetInt32());
            Assert.Equal("Trips", only.GetProperty("name").GetString());
            Assert.Contains("flight", only.GetProperty("rulesJson").GetString());
        });
    }

    [Fact]
    public async Task Put_RefusesBrokenWrites_AndUnknownIds()
    {
        await WithAppAsync(async client =>
        {
            var created = await client.PostAsJsonAsync("/api/collections", new { name = "Japan", rulesJson = Rules("tag", "Japan") });
            var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

            Assert.Equal(HttpStatusCode.BadRequest,
                (await client.PutAsJsonAsync($"/api/collections/{id}", new { name = " ", rulesJson = Rules("tag", "x") })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await client.PutAsJsonAsync($"/api/collections/{id}", new { name = "x", rulesJson = "{not json" })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await client.PutAsJsonAsync($"/api/collections/{id}", new { name = "x", rulesJson = "{\"match\":\"all\",\"conditions\":[]}" })).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await client.PutAsJsonAsync($"/api/collections/{id + 999}", new { name = "x", rulesJson = Rules("tag", "x") })).StatusCode);

            // Nothing above touched the saved one.
            var only = Assert.Single(await client.GetFromJsonAsync<List<JsonElement>>("/api/collections") ?? []);
            Assert.Equal("Japan", only.GetProperty("name").GetString());
        });
    }

    private static async Task WithAppAsync(Func<HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-collections-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostSetupAsync(new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            await body(client);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }
}
