using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Notes are stored as `a-readable-title.md`, named after the title (else the
// first line), and the file follows the note as it's retitled.
public sealed class NoteFileNamerTests
{
    [Theory]
    [InlineData("Weekly Groceries!", "weekly-groceries")]
    [InlineData("  Café  crème — notes ", "cafe-creme-notes")]
    [InlineData("東京 trip", "東京-trip")]
    [InlineData("CON", "con-note")]
    [InlineData("!!!", "")]
    public void Slug_IsLowerCaseHyphenatedAndSafe(string title, string expected)
    {
        Assert.Equal(expected, NoteFileNamer.Slug(title));
    }

    [Fact]
    public void Slug_IsCappedAtAWordBoundary()
    {
        var slug = NoteFileNamer.Slug(string.Join(' ', Enumerable.Repeat("chapter", 20)));
        Assert.True(slug.Length <= 60);
        Assert.EndsWith("chapter", slug);
    }

    [Fact]
    public void Name_PrefersTheTitle_ThenTheFirstLine_ThenNothing()
    {
        Assert.Equal("plan", NoteFileNamer.DesiredBaseName(new Note { Title = "Plan", Body = "# Something else" }));
        Assert.Equal("buy-milk-and-eggs", NoteFileNamer.DesiredBaseName(new Note { Title = "", Body = "\n- [ ] **Buy** milk and eggs\n" }));
        // One keystroke is not a name yet: the file keeps its id-based one.
        Assert.Null(NoteFileNamer.DesiredBaseName(new Note { Title = "", Body = "a" }));
    }

    [Fact]
    public void ANameSomeoneChose_IsNeverRenamed()
    {
        var dir = Path.GetTempPath();
        var human = Path.Combine(dir, "My Recipes.md");
        Assert.Equal(human, NoteFileNamer.TargetPath(human, "chai-properly", "n1"));
        // Papyra's own names do follow the note.
        var ours = Path.Combine(dir, "3f2c9a1e-8d4b-4c6e-9f00-1234567890ab.md");
        Assert.EndsWith("chai-properly.md", NoteFileNamer.TargetPath(ours, "chai-properly", "3f2c9a1e-8d4b-4c6e-9f00-1234567890ab"));
    }

    [Fact]
    public async Task Put_NamesTheFile_FollowsARetitle_AndAvoidsCollisions()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-names-" + Guid.NewGuid().ToString("N"));
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
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            var notesDir = Directory.GetDirectories(Path.Combine(dir, "users")).Single() + "/notes";

            // First keystroke: nothing to name it after, so the id stands in.
            await client.PutAsJsonAsync("/api/notes/7f3a9c2e", new NoteWrite("", null, null, false, false, "a"));
            Assert.Equal("7f3a9c2e.md", Path.GetFileName(NoteFiles.Find(notesDir, "7f3a9c2e")));

            // A title arrives: the file takes its name.
            await client.PutAsJsonAsync("/api/notes/7f3a9c2e", new NoteWrite("Trip Plan", null, null, false, false, "a"));
            Assert.Equal("trip-plan.md", Path.GetFileName(NoteFiles.Find(notesDir, "7f3a9c2e")));

            // Another note with the same title gets the next free name…
            await client.PutAsJsonAsync("/api/notes/other", new NoteWrite("Trip plan", null, null, false, false, "b"));
            Assert.Equal("trip-plan-2.md", Path.GetFileName(NoteFiles.Find(notesDir, "other")));
            // …and keeps it on later saves, rather than trading names.
            await client.PutAsJsonAsync("/api/notes/other", new NoteWrite("Trip plan", null, null, false, false, "b2"));
            Assert.Equal("trip-plan-2.md", Path.GetFileName(NoteFiles.Find(notesDir, "other")));

            // Retitled: renamed, old file gone, note still addressable by id.
            await client.PutAsJsonAsync("/api/notes/7f3a9c2e", new NoteWrite("Lisbon", null, null, false, false, "a"));
            Assert.Equal("lisbon.md", Path.GetFileName(NoteFiles.Find(notesDir, "7f3a9c2e")));
            Assert.False(File.Exists(Path.Combine(notesDir, "trip-plan.md")));
            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Single(notes!, n => n.Id == "7f3a9c2e" && n.Title == "Lisbon");
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
