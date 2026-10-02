using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Caching.Memory;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// A .md file another tool (Obsidian, an editor, Syncthing) creates without an
// `id:` used to be listed as {"id":"","title":""}, unsearchable, and dropped
// entirely on the next restart. These cover the pieces that adopt it instead.
public sealed class ForeignNoteAdopterTests
{
    private readonly MarkdownStorageService _storage = new();

    // ── Stamping the id into the file ─────────────────────────────────────────

    [Fact]
    public void StampId_NoFrontmatter_AddsOne_AndTheBodyReadsBackTheSame()
    {
        const string content = "# Made in Obsidian\n\nNo frontmatter at all.\n";

        var stamped = _storage.StampId(content, "n1")!;

        Assert.Equal("---\nid: 'n1'\n---\n\n" + content, stamped);
        var back = _storage.Deserialize(stamped);
        Assert.Equal("n1", back.Id);
        Assert.Equal(_storage.Deserialize(content).Body, back.Body);
    }

    [Fact]
    public void StampId_ForeignFrontmatter_AddsOneLine_AndKeepsEveryOtherByte()
    {
        // Key order, a comment, Obsidian's list style and CRLF line endings — all
        // things a full re-render would have rewritten.
        const string content =
            "---\r\naliases:\r\n  - Groceries\r\n# my comment\r\ncssclasses: [wide]\r\n---\r\n\r\nmilk\r\n";

        var stamped = _storage.StampId(content, "n1")!;

        Assert.Equal(
            "---\r\nid: 'n1'\r\naliases:\r\n  - Groceries\r\n# my comment\r\ncssclasses: [wide]\r\n---\r\n\r\nmilk\r\n",
            stamped);
        var back = _storage.Deserialize(stamped);
        Assert.Equal("n1", back.Id);
        Assert.True(back.ExtraFrontmatter.ContainsKey("aliases"));
        Assert.True(back.ExtraFrontmatter.ContainsKey("cssclasses"));
    }

    [Theory]
    [InlineData("id:")]
    [InlineData("id: ''")]
    [InlineData("id: \"\"")]
    [InlineData("id: null")]
    public void StampId_BlankIdKey_IsFilledIn_NotDuplicated(string blank)
    {
        var content = $"---\ntags: [a]\n{blank}\n---\n\nbody";

        var stamped = _storage.StampId(content, "n1")!;

        Assert.Equal("---\ntags: [a]\nid: 'n1'\n---\n\nbody", stamped);
        var back = _storage.Deserialize(stamped);
        Assert.Equal("n1", back.Id);
        Assert.Equal(["a"], back.Tags); // a duplicate key would have voided the whole map
    }

    [Fact]
    public void StampId_YamlItCannotParse_IsLeftAlone()
    {
        Assert.Null(_storage.StampId("---\ntags: [unclosed\n---\n\nbody", "n1"));
    }

    [Fact]
    public void StampId_IdThatLooksLikeAYamlScalar_ReadsBackAsTheSameString()
    {
        Assert.Equal("null", _storage.Deserialize(_storage.StampId("x", "null")!).Id);
        Assert.Equal("1e5", _storage.Deserialize(_storage.StampId("x", "1e5")!).Id);
    }

    // ── Title ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ReadAsync_FileWithoutATitleKey_IsNamedByHeadingThenFileName()
    {
        var dir = NewTempDir();
        try
        {
            var headed = Path.Combine(dir, "made-in-obsidian.md");
            var bare = Path.Combine(dir, "Shopping List.md");
            var papyra = Path.Combine(dir, "untitled.md");
            await File.WriteAllTextAsync(headed, "# Made in Obsidian\n\nNo frontmatter at all.\n");
            await File.WriteAllTextAsync(bare, "---\ntags: [x]\n---\n\nmilk, eggs");
            // Papyra always writes a title key, even an empty one: that's a
            // deliberately untitled note and stays untitled.
            await File.WriteAllTextAsync(papyra, "---\nid: p1\ntitle: ''\n---\n\n# Looks like a heading");

            Assert.Equal("Made in Obsidian", (await _storage.ReadAsync(headed))!.Title);
            Assert.Equal("Shopping List", (await _storage.ReadAsync(bare))!.Title);
            Assert.Equal(string.Empty, (await _storage.ReadAsync(papyra))!.Title);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ── Deriving the id ───────────────────────────────────────────────────────

    [Fact]
    public void DeriveId_IsAStableValidNoteId_PerPath()
    {
        var notesDir = Path.Combine(Path.GetTempPath(), "vault");
        var a = Path.Combine(notesDir, "made-in-obsidian.md");

        var id = ForeignNoteAdopter.DeriveId(notesDir, a, _ => false);

        Assert.True(PathGuard.IsValidNoteId(id));
        Assert.True(Guid.TryParse(id, out _));
        Assert.Equal(id, ForeignNoteAdopter.DeriveId(notesDir, a, _ => false)); // same file, same id
        Assert.NotEqual(id, ForeignNoteAdopter.DeriveId(notesDir, Path.Combine(notesDir, "sub", "made-in-obsidian.md"), _ => false));
        // Not the file name: NoteFileNamer would take a name equal to the id for
        // one Papyra chose and rename the user's file after its title.
        Assert.False(NoteFileNamer.IsPapyraName("Recipes", ForeignNoteAdopter.DeriveId(notesDir, Path.Combine(notesDir, "Recipes.md"), _ => false)));
    }

    [Fact]
    public void DeriveId_StepsPastAnIdAlreadyTaken_Deterministically()
    {
        var notesDir = Path.Combine(Path.GetTempPath(), "vault");
        var path = Path.Combine(notesDir, "a.md");
        var first = ForeignNoteAdopter.DeriveId(notesDir, path, _ => false);

        var second = ForeignNoteAdopter.DeriveId(notesDir, path, id => id == first);

        Assert.NotEqual(first, second);
        Assert.True(PathGuard.IsValidNoteId(second));
        Assert.Equal(second, ForeignNoteAdopter.DeriveId(notesDir, path, id => id == first));
    }

    // ── Adopting ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task AdoptAsync_WritesTheIdBack_KeepingForeignKeysAndMtime_MarkedAsASelfWrite()
    {
        var dir = NewTempDir();
        try
        {
            var path = Path.Combine(dir, "foreign.md");
            await File.WriteAllTextAsync(path, "---\naliases: [f]\n---\n\n# Foreign\n\ntext");
            var mtime = new DateTime(2024, 5, 1, 12, 0, 0, DateTimeKind.Utc);
            File.SetLastWriteTimeUtc(path, mtime);
            var ring = new WriteRing(new MemoryCache(new MemoryCacheOptions()));
            var note = (await _storage.ReadAsync(path))!;

            var adopted = await new ForeignNoteAdopter(_storage, ring).AdoptAsync(dir, path, note, _ => false);

            Assert.True(adopted);
            Assert.Equal(ForeignNoteAdopter.DeriveId(dir, path, _ => false), note.Id);
            Assert.Equal($"---\nid: '{note.Id}'\naliases: [f]\n---\n\n# Foreign\n\ntext", await File.ReadAllTextAsync(path));
            Assert.Equal(mtime, File.GetLastWriteTimeUtc(path)); // adopting is not an edit
            Assert.True(ring.IsSelfWrite(path));                  // the watcher skips the echo
            Assert.Equal(note.Id, (await _storage.ReadAsync(path))!.Id);
            Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task AdoptAsync_KeepsTheIdThePathAlreadyHad_AndLeavesNotesWithIdsAlone()
    {
        var dir = NewTempDir();
        try
        {
            var path = Path.Combine(dir, "n.md");
            await File.WriteAllTextAsync(path, "stale buffer saved over the stamped file");
            var adopter = new ForeignNoteAdopter(_storage, new WriteRing(new MemoryCache(new MemoryCacheOptions())));

            var note = (await _storage.ReadAsync(path))!;
            await adopter.AdoptAsync(dir, path, note, _ => false, preferredId: "known-id");
            Assert.Equal("known-id", note.Id);

            var owned = new Note { Id = "mine" };
            Assert.False(await adopter.AdoptAsync(dir, path, owned, _ => false));
            Assert.Equal("mine", owned.Id);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-adopt-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}

// The issue's own repro, end to end through the API: drop an id-less file into a
// running server's vault, then list and search; restart, and it is still there
// under the same id.
[Collection(TimingSensitiveCollection.Name)]
public sealed class ForeignNoteAdoptionApiTests
{
    private const string Pw = "hunter2!";

    [Fact]
    public async Task IdlessFile_IsListedSearchableAndOpenable_AndKeepsItsIdAcrossARestart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-adopt-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = NewApp(dir);
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostSetupAsync(new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            var notesDir = Path.Combine(dir, "users", "1", "notes");
            var path = Path.Combine(notesDir, "made-in-obsidian.md");

            // Re-emit until the watcher (armed asynchronously) has seen it.
            Note? listed = null;
            var sw = Stopwatch.StartNew();
            while (listed is null && sw.ElapsedMilliseconds < 15_000)
            {
                if (!File.Exists(path) || !(await File.ReadAllTextAsync(path)).Contains("id:"))
                    await File.WriteAllTextAsync(path, "# Made in Obsidian\n\nNo frontmatter at all.\n");
                await Task.Delay(200);
                listed = (await client.GetFromJsonAsync<List<Note>>("/api/notes"))!
                    .FirstOrDefault(n => n.Title == "Made in Obsidian");
            }

            Assert.NotNull(listed);
            Assert.True(PathGuard.IsValidNoteId(listed.Id));
            Assert.DoesNotContain(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [], n => n.Id == "");
            var hits = await client.GetFromJsonAsync<JsonElement>("/api/search?q=Obsidian");
            Assert.Contains(hits.EnumerateArray(), h => h.GetProperty("id").GetString() == listed.Id);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/notes/{listed.Id}/blocks")).StatusCode);
            Assert.Contains($"id: '{listed.Id}'", await File.ReadAllTextAsync(path));

            // Restart: the cold-boot walk used to skip id-less files outright.
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            factory = NewApp(dir);
            var again = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await again.LoginAsync("owner", Pw)).StatusCode);
            var after = await again.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Contains(after!, n => n.Id == listed.Id && n.Title == "Made in Obsidian");
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
        }
    }

    private static WebApplicationFactory<Program> NewApp(string dir) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
}
