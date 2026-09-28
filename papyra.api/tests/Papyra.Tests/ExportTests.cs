using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// The plain-zip export: dated file name, and each entry keeps its own note's
// last-modified time (in the person's zone) rather than all reading alike.
public sealed class ExportTests
{
    [Fact]
    public async Task Export_IsDated_AndEachFileKeepsItsOwnModifiedTime()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, TimeZone: "Asia/Kolkata"));
            await client.PutAsJsonAsync("/api/notes/old", new NoteWrite("Old", null, null, false, false, "old"));
            await client.PutAsJsonAsync("/api/notes/new", new NoteWrite("New", null, null, false, false, "new"));
            // Stamped block markers nobody links to are left out of the export.
            await client.PutAsJsonAsync("/api/notes/anch", new NoteWrite("Anchored", null, null, false, false, "Line one ^k2x9abcd\n\nLine two ^zz11yy22"));

            // Back-date one note on disk, as an import or another app would.
            var oldFile = Directory.EnumerateFiles(dir, "*.md", SearchOption.AllDirectories)
                .Single(f => File.ReadAllText(f).Contains("old"));
            var when = new DateTime(2024, 3, 5, 10, 30, 0, DateTimeKind.Utc);
            File.SetLastWriteTimeUtc(oldFile, when);

            var ticket = (await (await client.PostAsJsonAsync("/api/export/authorize", new { password = "hunter2!" }))
                .Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()).GetProperty("ticket").GetString();
            var res = await client.GetAsync($"/api/export?ticket={ticket}");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Matches(@"^papyra-export-\d{4}-\d{2}-\d{2}-\d{4}\.zip$",
                res.Content.Headers.ContentDisposition!.FileNameStar ?? res.Content.Headers.ContentDisposition.FileName!.Trim('"'));

            using var zip = new ZipArchive(await res.Content.ReadAsStreamAsync());
            var entry = zip.Entries.Single(e => e.FullName == Path.GetFileName(oldFile));
            // 10:30 UTC is 16:00 in Kolkata; zip stores the local clock time.
            Assert.Equal(new DateTime(2024, 3, 5, 16, 0, 0), entry.LastWriteTime.DateTime);
            Assert.Contains(zip.Entries, e => e.LastWriteTime.Year != 2024); // the other note is today's
            var anchored = new StreamReader(zip.Entries.Single(e => e.FullName == "anchored.md").Open()).ReadToEnd();
            Assert.Contains("Line one\n", anchored.Replace("\r\n", "\n") + "\n");
            Assert.DoesNotContain("^k2x9abcd", anchored);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
