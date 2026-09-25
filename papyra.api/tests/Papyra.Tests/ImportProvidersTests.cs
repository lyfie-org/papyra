using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
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
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
    }

    private static byte[] Zip(params (string Name, string Content)[] entries) =>
        ZipAt(new DateTimeOffset(2024, 3, 5, 10, 20, 30, TimeSpan.Zero), entries);

    private static byte[] ZipAt(DateTimeOffset stamp, params (string Name, string Content)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                var e = zip.CreateEntry(name);
                e.LastWriteTime = stamp;
                using var w = new StreamWriter(e.Open(), Encoding.UTF8);
                w.Write(content);
            }
        }
        return ms.ToArray();
    }

    // Post an archive and wait for its job to report done; returns the final status.
    private static async Task<JsonElement> ImportAsync(HttpClient client, string provider, byte[] zip)
    {
        var res = await PostZipAsync(client, provider, zip);
        Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);
        var jobId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString();
        for (var i = 0; i < 100; i++)
        {
            var status = await client.GetFromJsonAsync<JsonElement>("/api/import/status");
            if (status.GetProperty("jobId").GetString() == jobId && status.GetProperty("done").GetBoolean())
                return status;
            await Task.Delay(100);
        }
        throw new TimeoutException("Import never finished.");
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

    // Takeout stamps: created 2023-01-02, edited 2024-06-07 (microseconds).
    private const string KeepColored =
        """{"color":"RED","isTrashed":false,"isPinned":false,"isArchived":true,"title":"Red note","textContent":"hello","createdTimestampUsec":1672617600000000,"userEditedTimestampUsec":1717747200000000,"annotations":[{"url":"https://example.com","title":"Example","source":"WEBLINK"}]}""";

    [Fact]
    public async Task KeepImport_CarriesColourTimesAndOrder_AndReimportNeverDuplicates()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            var first = await ImportAsync(client, "keep", Zip(("Keep/red.json", KeepColored)));
            Assert.Equal(1, first.GetProperty("imported").GetInt32());

            var note = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.Equal("#ecd9da", note.Color); // Keep RED → Rose swatch
            Assert.True(note.Archived);
            Assert.Contains("[Example](https://example.com)", note.Body);
            // Last-modified is Keep's edit time, not the moment of import.
            Assert.Equal(new DateTime(2024, 6, 7, 8, 0, 0, DateTimeKind.Utc), note.Updated.ToUniversalTime(), TimeSpan.FromSeconds(1));

            // Keep's grid is newest-created first; placed by creation time.
            var order = await client.GetFromJsonAsync<JsonElement>("/api/notes/order");
            Assert.Equal(1672617600000d, order.GetProperty(note.Id).GetProperty("key").GetDouble());

            // Same archive again: recognised, left alone, not duplicated.
            var again = await ImportAsync(client, "keep", Zip(("Keep/red.json", KeepColored)));
            Assert.Equal(0, again.GetProperty("imported").GetInt32());
            Assert.Equal(1, again.GetProperty("unchanged").GetInt32());
            Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);

            // Edited in Keep since: overwritten in place with the new version.
            var edited = KeepColored.Replace("hello", "hello again").Replace("RED", "BLUE")
                .Replace("1717747200000000", "1720000000000000");
            var third = await ImportAsync(client, "keep", Zip(("Keep/red.json", edited)));
            Assert.Equal(1, third.GetProperty("updated").GetInt32());
            var updated = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.Equal(note.Id, updated.Id);
            Assert.StartsWith("hello again", updated.Body);
            Assert.Equal("#d8e3ea", updated.Color);
            Assert.Equal(DateTime.UnixEpoch.AddSeconds(1720000000), updated.Updated.ToUniversalTime(), TimeSpan.FromSeconds(1));
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ObsidianImport_PinsBookmarks_KeepsMtime_SkipsConfig_AndReimportIsUnchanged()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);
            // Zip stamps are zone-less wall-clock time, read back as server-local.
            var stamp = new DateTimeOffset(new DateTime(2022, 8, 9, 12, 0, 0, DateTimeKind.Local));
            byte[] Vault(string body) => ZipAt(stamp,
                ("MyVault/.obsidian/bookmarks.json",
                 """{"items":[{"type":"group","items":[{"type":"file","path":"Projects/Plan.md"}]}]}"""),
                ("MyVault/.obsidian/workspace.json", "{}"),
                ("MyVault/.trash/Old.md", "gone"),
                ("MyVault/Projects/Plan.md", "---\ntags: ['#work']\n---\n\n" + body),
                ("MyVault/Loose.md", "loose note"));

            var first = await ImportAsync(client, "obsidian", Vault("the plan"));
            Assert.Equal(2, first.GetProperty("imported").GetInt32());

            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [];
            Assert.Equal(2, notes.Count);
            var plan = Assert.Single(notes, n => n.Title == "Plan");
            Assert.True(plan.Pinned);
            Assert.Equal(["work"], plan.Tags);
            Assert.Equal(stamp.UtcDateTime, plan.Updated.ToUniversalTime(), TimeSpan.FromSeconds(2));
            // Obsidian's config never lands in the media dir.
            Assert.False(File.Exists(Path.Combine(dir, "users", uid, "media", "workspace.json")));

            var again = await ImportAsync(client, "obsidian", Vault("the plan"));
            Assert.Equal(2, again.GetProperty("unchanged").GetInt32());
            Assert.Equal(2, (await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []).Count);

            var changed = await ImportAsync(client, "obsidian", Vault("the revised plan"));
            Assert.Equal(1, changed.GetProperty("updated").GetInt32());
            Assert.Equal(1, changed.GetProperty("unchanged").GetInt32());
            var revised = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [], n => n.Title == "Plan");
            Assert.Equal(plan.Id, revised.Id);
            Assert.Contains("revised", revised.Body);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void KeepColours_FoldOntoThePalette()
    {
        Assert.Null(Papyra.Api.Storage.ImportService.MapKeepColor("DEFAULT"));
        Assert.Equal("#e2dcec", Papyra.Api.Storage.ImportService.MapKeepColor("PURPLE"));
        Assert.Null(Papyra.Api.Storage.ImportService.MapKeepColor("NEON"));
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
