using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

public sealed class HealthEndpointTests
{
    [Fact]
    public async Task Health_ReturnsOkWithHealthyStatus()
    {
        // A bare factory boots in Development, where DataDir resolves to the API's
        // .localdata dev vault; give the test its own throwaway folder instead.
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });

        try
        {
            var client = factory.CreateClient();

            var response = await client.GetAsync("/health");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<HealthResponse>();
            Assert.Equal("Healthy", body?.Status);
            // The native image library loaded: thumbnails are offered.
            Assert.Equal("ok", body?.Thumbnails);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
        }
    }

    private sealed record HealthResponse(string Status, string App, string? Thumbnails);
}
