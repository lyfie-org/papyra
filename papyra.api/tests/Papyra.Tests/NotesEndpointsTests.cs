using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

public sealed class NotesEndpointsTests
{
    // Point the data dir at a throwaway temp folder so the test owns its vault.
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            // UseSetting lands in IConfiguration reliably under minimal hosting,
            // unlike ConfigureAppConfiguration which doesn't merge here.
            b.UseSetting("Papyra:DataDir", dir);
        });

        return (factory, dir);
    }

    // Clear the init gate: the first /api/auth/setup creates the admin so the
    // notes endpoints stop returning 428.
    private static async Task SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Setup_FirstCallCreatesAdmin_SecondConflicts()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            var again = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "other", Name: null, Email: null, Password: "pw"));
            Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        }
        finally
        {
            factory.Dispose();
            // SQLite pools connections by string; release the file handle before
            // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Notes_BeforeSetup_Returns428()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var res = await client.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.PreconditionRequired, res.StatusCode);
        }
        finally
        {
            factory.Dispose();
            // SQLite pools connections by string; release the file handle before
            // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Put_WritesMarkdownToDisk_AndGetServesIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            var put = await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
                Title: "Hello", Tags: ["a", "b"], Color: "#7aaa8a", Pinned: true, Archived: false, Body: "world"));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            var mdPath = Path.Combine(dir, "notes", "n1.md");
            Assert.True(File.Exists(mdPath));
            var raw = await File.ReadAllTextAsync(mdPath);
            Assert.Contains("title: Hello", raw);
            Assert.Contains("world", raw);

            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
            var note = Assert.Single(notes!);
            Assert.Equal("n1", note.Id);
            Assert.Equal("Hello", note.Title);
            Assert.True(note.Pinned);
        }
        finally
        {
            factory.Dispose();
            // SQLite pools connections by string; release the file handle before
            // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Delete_RemovesFileAndDropsFromVault()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);
            await client.PutAsJsonAsync("/api/notes/d1", new NoteWrite(
                Title: "Doomed", Tags: null, Color: null, Pinned: false, Archived: false, Body: "bye"));

            var del = await client.DeleteAsync("/api/notes/d1");
            Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

            Assert.False(File.Exists(Path.Combine(dir, "notes", "d1.md")));

            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Empty(notes!);
        }
        finally
        {
            factory.Dispose();
            // SQLite pools connections by string; release the file handle before
            // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Delete_UnknownId_Returns404()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);
            var del = await client.DeleteAsync("/api/notes/nope");
            Assert.Equal(HttpStatusCode.NotFound, del.StatusCode);
        }
        finally
        {
            factory.Dispose();
            // SQLite pools connections by string; release the file handle before
            // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
