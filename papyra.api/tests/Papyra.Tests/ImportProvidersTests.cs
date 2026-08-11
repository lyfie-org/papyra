using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// Provider imports run on a background worker, so these drive the real endpoint
// and poll the vault. They pin the mappings a migrating user actually notices:
// a Keep checklist is a to-do, a trashed Keep note stays gone, and an Obsidian
// note keeps the frontmatter keys Papyra doesn't own.
public sealed class ImportProvidersTests
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
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
    }

    private static byte[] Zip(params (string Name, string Content)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                var e = zip.CreateEntry(name);
                using var w = new StreamWriter(e.Open(), Encoding.UTF8);
                w.Write(content);
            }
        }
        return ms.ToArray();
    }

    private static async Task<HttpResponseMessage> PostZipAsync(
        HttpClient client, string provider, byte[] zip)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(zip);
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
        form.Add(file, "file", "import.zip");
        return await client.PostAsync($"/api/import/{provider}", form);
    }

    // The worker owns the parse, so wait for the vault to settle rather than sleeping.
    private static async Task<List<Note>> WaitForNotesAsync(HttpClient client, int expected)
    {
        for (var i = 0; i < 60; i++)
        {
            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [];
            if (notes.Count >= expected) return notes;
            await Task.Delay(100);
        }
        return await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [];
    }

    [Fact]
    public async Task KeepImport_MapsChecklistToTodo_PinAndLabels_AndSkipsTrashed()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            var zip = Zip(
                ("pinned.json",
                 """{"isTrashed":false,"isPinned":true,"isArchived":false,"title":"Pinned note","textContent":"prose body","labels":[{"name":"errands"}]}"""),
                ("checklist.json",
                 """{"isTrashed":false,"isPinned":false,"isArchived":false,"title":"Shopping","listContent":[{"text":"milk","isChecked":false},{"text":"bread","isChecked":true}]}"""),
                ("trashed.json",
                 """{"isTrashed":true,"isPinned":false,"isArchived":false,"title":"Deleted note","textContent":"must not be imported"}"""));

            var res = await PostZipAsync(client, "keep", zip);
            Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);

            var notes = await WaitForNotesAsync(client, 2);

            var pinned = Assert.Single(notes, n => n.Title == "Pinned note");
            Assert.True(pinned.Pinned);
            Assert.Contains("errands", pinned.Tags);
            Assert.Equal("note", pinned.Kind);

            // A checklist belongs on the To Do page, with its checked state intact.
            var list = Assert.Single(notes, n => n.Title == "Shopping");
            Assert.Equal("todo", list.Kind);
            Assert.Contains("- [ ] milk", list.Body);
            Assert.Contains("- [x] bread", list.Body);

            Assert.DoesNotContain(notes, n => n.Title == "Deleted note");
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ObsidianImport_KeepsForeignFrontmatterAndTags()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);

            var zip = Zip(("Zettel.md",
                "---\ntags: [research, zettel]\nobsidianCustomKey: keep-me-please\n---\n\n"
                + "# Zettelkasten\n\nLinks to [[Second Note]].\n"));

            var res = await PostZipAsync(client, "obsidian", zip);
            Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);

            var notes = await WaitForNotesAsync(client, 1);
            var note = Assert.Single(notes);
            Assert.Equal("Zettel", note.Title);
            Assert.Contains("research", note.Tags);
            Assert.Contains("[[Second Note]]", note.Body);

            // The key Papyra doesn't own has to survive the round-trip to disk, or
            // importing from Obsidian quietly strips the user's own metadata.
            var mdPath = Path.Combine(dir, "users", uid, "notes", $"{note.Id}.md");
            var raw = await File.ReadAllTextAsync(mdPath);
            Assert.Contains("obsidianCustomKey: keep-me-please", raw);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task UnknownProvider_IsRejected()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);
            var res = await PostZipAsync(client, "banana", Zip(("a.json", "{}")));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
