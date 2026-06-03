using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Services;
using Xunit;

namespace Papyra.Tests.Services;

// 💡 Fixture to manage a single Lucene Index and FileSystemWatcher for all search tests
public sealed class NoteSearchFixture : IAsyncLifetime
{
    public string StorageRoot { get; } = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    public string IndexDir { get; } = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    
    public IndexManager Index { get; private set; } = null!;
    public NoteWatcherService Watcher { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(StorageRoot);
        
        Index = new IndexManager(IndexDir);
        Watcher = new NoteWatcherService(
            new MarkdownStorageService(),
            NullLogger<NoteWatcherService>.Instance,
            StorageRoot,
            Index);

        await Watcher.StartAsync(CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        if (Watcher != null)
        {
            await Watcher.StopAsync(CancellationToken.None);
            Watcher.Dispose();
        }
        Index?.Dispose();
        
        if (Directory.Exists(StorageRoot)) Directory.Delete(StorageRoot, recursive: true);
        if (Directory.Exists(IndexDir))    Directory.Delete(IndexDir,    recursive: true);
    }
}

/// <summary>
/// Integration tests: storage root + Lucene index wired together through NoteWatcherService.
/// </summary>
[Collection("SequentialIntegrationTests")]
public sealed class NoteSearchIntegrationTests : IClassFixture<NoteSearchFixture>
{
    private readonly NoteSearchFixture _fixture;

    public NoteSearchIntegrationTests(NoteSearchFixture fixture)
    {
        _fixture = fixture;
    }

    // ── Create ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileCreated_SearchFindsNoteByContentKeyword()
    {
        WriteNote("srch-1", "Searchable", "This note contains butterfly keyword");

        await WaitForNote("srch-1");

        Assert.Contains(_fixture.Index.Search("butterfly"), r => r.Id == "srch-1");
    }

    [Fact]
    public async Task FileCreated_SearchFindsNoteByTitle()
    {
        WriteNote("srch-2", "Quasar Discovery", "some body");

        await WaitForNote("srch-2");

        Assert.Contains(_fixture.Index.Search("Quasar"), r => r.Id == "srch-2");
    }

    [Fact]
    public async Task MultipleFilesCreated_SearchIsolatesCorrectNote()
    {
        WriteNote("srch-a", "Rocket Science", "orbital mechanics propulsion");
        WriteNote("srch-b", "Baking Bread",   "flour yeast butter");
        WriteNote("srch-c", "Rocket Launch",  "countdown ignition liftoff");

        await WaitForNote("srch-a");
        await WaitForNote("srch-b");
        await WaitForNote("srch-c");

        var results = _fixture.Index.Search("orbital");
        Assert.Contains(results,       r => r.Id == "srch-a");
        Assert.DoesNotContain(results, r => r.Id == "srch-b");
        Assert.DoesNotContain(results, r => r.Id == "srch-c");
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileDeleted_NoteRemovedFromSearchIndex()
    {
        var path = WriteNote("srch-del", "Ephemeral", "fleeting quasar content");

        await WaitForNote("srch-del");
        Assert.Contains(_fixture.Index.Search("quasar"), r => r.Id == "srch-del");

        File.Delete(path);
        await WaitForNoteGone("srch-del");
        
        // Brief pause: RemoveFromIndex runs synchronously in the FSW callback right
        // after TryRemove, but the test thread may preempt between the two.
        await Task.Delay(100);

        Assert.DoesNotContain(_fixture.Index.Search("quasar"), r => r.Id == "srch-del");
    }

    // ── Update ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileChanged_IndexReflectsNewContent()
    {
        var path = WriteNote("srch-upd", "Evolving", "old content nebula");

        await WaitForNote("srch-upd");
        Assert.Contains(_fixture.Index.Search("nebula"), r => r.Id == "srch-upd");

        File.WriteAllText(path, MakeRaw("srch-upd", "Evolving", "new content pulsar"));

        await PollAsync(() => _fixture.Index.Search("pulsar").Any(r => r.Id == "srch-upd"));

        Assert.Contains(_fixture.Index.Search("pulsar"),       r => r.Id == "srch-upd");
        Assert.DoesNotContain(_fixture.Index.Search("nebula"), r => r.Id == "srch-upd");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Creates [storageRoot]/{noteId}/note.md and returns the full path to the file.
    private string WriteNote(string noteId, string title, string content = "")
    {
        var noteDir = Path.Combine(_fixture.StorageRoot, noteId);
        Directory.CreateDirectory(noteDir);
        var path = Path.Combine(noteDir, "note.md");
        File.WriteAllText(path, MakeRaw(noteId, title, content));
        return path;
    }

    private static string MakeRaw(string id, string title, string content = "") =>
        $"---\nid: {id}\ntitle: \"{title}\"\ntags: []\npinned: false\ncolor: \"\"\n---\n{content}";

    private Task WaitForNote(string id) =>
        PollAsync(() => _fixture.Watcher.Notes.Values.Any(n => n.Id == id));

    private Task WaitForNoteGone(string id) =>
        PollAsync(() => !_fixture.Watcher.Notes.Values.Any(n => n.Id == id));

    private static async Task PollAsync(
        Func<bool> condition,
        int timeoutMs = 15000, 
        int intervalMs = 50)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            await Task.Delay(intervalMs);
        }
        throw new TimeoutException($"Condition not met within {timeoutMs}ms.");
    }
}