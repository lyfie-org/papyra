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
    // notes endpoints stop returning 428. Returns the admin's id, which keys their
    // on-disk vault at users/{id}/.
    private static async Task<string> SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
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
            var uid = await SeedAdminAsync(client);

            var put = await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
                Title: "Hello", Tags: ["a", "b"], Color: "#7aaa8a", Pinned: true, Archived: false, Body: "world"));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            var mdPath = Path.Combine(dir, "users", uid, "notes", "n1.md");
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
            var uid = await SeedAdminAsync(client);
            await client.PutAsJsonAsync("/api/notes/d1", new NoteWrite(
                Title: "Doomed", Tags: null, Color: null, Pinned: false, Archived: false, Body: "bye"));

            var del = await client.DeleteAsync("/api/notes/d1");
            Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

            Assert.False(File.Exists(Path.Combine(dir, "users", uid, "notes", "d1.md")));

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
    public async Task Notes_UserExistsButNotSignedIn_Returns401()
    {
        var (factory, dir) = NewApp();
        try
        {
            var seeded = factory.CreateClient();
            await SeedAdminAsync(seeded); // a user now exists → past the 428 init gate

            // A second client shares the DB but carries no auth cookie.
            var anon = factory.CreateClient();
            var res = await anon.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Login_GoodCredentials_GrantsAccess_LogoutRevokes()
    {
        var (factory, dir) = NewApp();
        try
        {
            var seeded = factory.CreateClient();
            await SeedAdminAsync(seeded);

            var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/api/auth/login",
                new LoginRequest(Username: "admin", Password: "hunter2"));
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);

            var ok = await client.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

            var logout = await client.PostAsync("/api/auth/logout", content: null);
            Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

            var after = await client.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Login_BadPassword_Returns401()
    {
        var (factory, dir) = NewApp();
        try
        {
            var seeded = factory.CreateClient();
            await SeedAdminAsync(seeded);

            var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/api/auth/login",
                new LoginRequest(Username: "admin", Password: "wrong"));
            Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
        }
        finally
        {
            factory.Dispose();
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

    [Fact]
    public async Task ApiKey_AuthenticatesViaXApiKeyHeader_InheritsOwnerVault()
    {
        var (factory, dir) = NewApp();
        try
        {
            // Owner signs in (cookie) and mints a personal access token.
            var owner = factory.CreateClient();
            var uid = await SeedAdminAsync(owner);
            await owner.PutAsJsonAsync("/api/notes/k1", new NoteWrite(
                Title: "Keyed", Tags: null, Color: null, Pinned: false, Archived: false, Body: "via key"));

            var keyRes = await owner.PostAsJsonAsync("/api/keys", new ApiKeyWrite("CLI"));
            Assert.Equal(HttpStatusCode.OK, keyRes.StatusCode);
            var token = (await keyRes.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>())
                .GetProperty("token").GetString()!;

            // A cookieless client authenticates with X-API-Key and sees the owner's notes.
            var script = factory.CreateClient();
            script.DefaultRequestHeaders.Add("X-API-Key", token);
            var notes = await script.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Equal("k1", Assert.Single(notes!).Id); // same UserId → same vault

            // A bad token resolves to no principal → 401.
            var bad = factory.CreateClient();
            bad.DefaultRequestHeaders.Add("X-API-Key", "papyra_not-a-real-token");
            Assert.Equal(HttpStatusCode.Unauthorized, (await bad.GetAsync("/api/notes")).StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
