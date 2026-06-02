using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Services;

namespace Papyra.Tests.Services;

/// <summary>
/// Integration tests: storage root + Lucene index wired together through NoteWatcherService.
/// </summary>
public sealed class NoteSearchIntegrationTests : IAsyncLifetime
{
    private readonly string _storageRoot =
        Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private readonly string _indexDir =
        Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());

    private readonly IndexManager _index;
    private readonly NoteWatcherService _watcher;

    public NoteSearchIntegrationTests()
    {
        _index   = new IndexManager(_indexDir);
        _watcher = new NoteWatcherService(
            new MarkdownStorageService(),
            NullLogger<NoteWatcherService>.Instance,
            _storageRoot,
            _index);
    }

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_storageRoot);
        await _watcher.StartAsync(CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        await _watcher.StopAsync(CancellationToken.None);
        _watcher.Dispose();
        _index.Dispose();
        if (Directory.Exists(_storageRoot)) Directory.Delete(_storageRoot, recursive: true);
        if (Directory.Exists(_indexDir))    Directory.Delete(_indexDir,    recursive: true);
    }

    // ── Create ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileCreated_SearchFindsNoteByContentKeyword()
    {
        WriteNote("srch-1", "Searchable", "This note contains butterfly keyword");

        await WaitForNote("srch-1");

        Assert.Contains(_index.Search("butterfly"), r => r.Id == "srch-1");
    }

    [Fact]
    public async Task FileCreated_SearchFindsNoteByTitle()
    {
        WriteNote("srch-2", "Quasar Discovery", "some body");

        await WaitForNote("srch-2");

        Assert.Contains(_index.Search("Quasar"), r => r.Id == "srch-2");
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

        var results = _index.Search("orbital");
        Assert.Contains(results,     r => r.Id == "srch-a");
        Assert.DoesNotContain(results, r => r.Id == "srch-b");
        Assert.DoesNotContain(results, r => r.Id == "srch-c");
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileDeleted_NoteRemovedFromSearchIndex()
    {
        var path = WriteNote("srch-del", "Ephemeral", "fleeting quasar content");

        await WaitForNote("srch-del");
        Assert.Contains(_index.Search("quasar"), r => r.Id == "srch-del");

        File.Delete(path);
        await WaitForNoteGone("srch-del");
        // Brief pause: RemoveFromIndex runs synchronously in the FSW callback right
        // after TryRemove, but the test thread may preempt between the two.
        await Task.Delay(100);

        Assert.DoesNotContain(_index.Search("quasar"), r => r.Id == "srch-del");
    }

    // ── Update ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileChanged_IndexReflectsNewContent()
    {
        var path = WriteNote("srch-upd", "Evolving", "old content nebula");

        await WaitForNote("srch-upd");
        Assert.Contains(_index.Search("nebula"), r => r.Id == "srch-upd");

        File.WriteAllText(path, MakeRaw("srch-upd", "Evolving", "new content pulsar"));

        await PollAsync(() => _index.Search("pulsar").Any(r => r.Id == "srch-upd"));

        Assert.Contains(_index.Search("pulsar"),   r => r.Id == "srch-upd");
        Assert.DoesNotContain(_index.Search("nebula"), r => r.Id == "srch-upd");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Creates [storageRoot]/{noteId}/note.md and returns the full path to the file.
    private string WriteNote(string noteId, string title, string content = "")
    {
        var noteDir = Path.Combine(_storageRoot, noteId);
        Directory.CreateDirectory(noteDir);
        var path = Path.Combine(noteDir, "note.md");
        File.WriteAllText(path, MakeRaw(noteId, title, content));
        return path;
    }

    private static string MakeRaw(string id, string title, string content = "") =>
        $"---\nid: {id}\ntitle: \"{title}\"\ntags: []\npinned: false\ncolor: \"\"\n---\n{content}";

    private Task WaitForNote(string id) =>
        PollAsync(() => _watcher.Notes.Values.Any(n => n.Id == id));

    private Task WaitForNoteGone(string id) =>
        PollAsync(() => !_watcher.Notes.Values.Any(n => n.Id == id));

    private static async Task PollAsync(
        Func<bool> condition,
        int timeoutMs = 4000,
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
