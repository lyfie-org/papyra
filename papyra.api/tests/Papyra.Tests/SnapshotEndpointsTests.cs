using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// Sprint 7.1: prior revisions are archived on overwrite, listable, fetchable, and
// an external truncation can be rolled back from a snapshot via the restore route.
public sealed class SnapshotEndpointsTests
{
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

    private static async Task<string> SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
    }

    private sealed record SnapshotDto(string Id, DateTime Timestamp);

    [Fact]
    public async Task SecondWrite_ArchivesPriorRevision_ThenRestoreRollsBack()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);

            // v1 then v2 → the v1 revision is archived before v2 overwrites it.
            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Doc", Tags: null, Color: null, Pinned: false, Archived: false, Body: "first version"));
            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Doc", Tags: null, Color: null, Pinned: false, Archived: false, Body: "second version"));

            var list = await client.GetFromJsonAsync<List<SnapshotDto>>("/api/notes/s1/snapshots");
            var snap = Assert.Single(list!);

            // The archived body is the prior (v1) content.
            var archived = await client.GetFromJsonAsync<Note>($"/api/notes/s1/snapshots/{snap.Id}");
            Assert.Contains("first version", archived!.Body);

            // Truncate the live note externally, then restore from the snapshot.
            var mdPath = Path.Combine(dir, "users", uid, "notes", "s1.md");
            await File.WriteAllTextAsync(mdPath, "");

            var restore = await client.PostAsync($"/api/notes/s1/restore/{snap.Id}", content: null);
            Assert.Equal(HttpStatusCode.OK, restore.StatusCode);

            var raw = await File.ReadAllTextAsync(mdPath);
            Assert.Contains("first version", raw);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
