using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Services;

namespace Papyra.Tests.Services;

public sealed class NoteWatcherServiceTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private readonly NoteWatcherService _sut;

    public NoteWatcherServiceTests()
    {
        _sut = new NoteWatcherService(
            new MarkdownStorageService(),
            NullLogger<NoteWatcherService>.Instance,
            _dir);
    }

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        await _sut.StartAsync(CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        await _sut.StopAsync(CancellationToken.None);
        _sut.Dispose();
        if (Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }

    // ── Startup load ──────────────────────────────────────────────────────────

    [Fact]
    public async Task StartAsync_LoadsExistingNoteMdFiles()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var noteDir = Path.Combine(dir, "pre-id");
        Directory.CreateDirectory(noteDir);
        File.WriteAllText(Path.Combine(noteDir, "note.md"), MakeRaw("pre-id", "Pre Note"));

        var svc = new NoteWatcherService(
            new MarkdownStorageService(),
            NullLogger<NoteWatcherService>.Instance,
            dir);

        try
        {
            await svc.StartAsync(CancellationToken.None);
            Assert.Single(svc.Notes);
            Assert.Contains(svc.Notes.Values, n => n.Id == "pre-id");
        }
        finally
        {
            await svc.StopAsync(CancellationToken.None);
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_IgnoresNonNoteMdFiles()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        // Flat .txt and a .md with a different name — neither should be picked up.
        File.WriteAllText(Path.Combine(dir, "ignore.txt"), "plain text");
        var someDir = Path.Combine(dir, "some-id");
        Directory.CreateDirectory(someDir);
        File.WriteAllText(Path.Combine(someDir, "other.md"), MakeRaw("x", "X"));

        var svc = new NoteWatcherService(
            new MarkdownStorageService(),
            NullLogger<NoteWatcherService>.Instance,
            dir);

        try
        {
            await svc.StartAsync(CancellationToken.None);
            Assert.Empty(svc.Notes);
        }
        finally
        {
            await svc.StopAsync(CancellationToken.None);
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    // ── Created ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileCreated_AddsNoteToDict()
    {
        var noteDir = Path.Combine(_dir, "note-1");
        Directory.CreateDirectory(noteDir);
        File.WriteAllText(Path.Combine(noteDir, "note.md"), MakeRaw("note-1", "Created Note"));

        var note = await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "note-1"));

        Assert.NotNull(note);
        Assert.Equal("Created Note", note.Title);
    }

    [Fact]
    public async Task MultipleFilesCreated_AllAddedToDict()
    {
        var dirA = Path.Combine(_dir, "id-a");
        var dirB = Path.Combine(_dir, "id-b");
        Directory.CreateDirectory(dirA);
        Directory.CreateDirectory(dirB);
        File.WriteAllText(Path.Combine(dirA, "note.md"), MakeRaw("id-a", "Alpha"));
        File.WriteAllText(Path.Combine(dirB, "note.md"), MakeRaw("id-b", "Beta"));

        await PollUntilAsync(() =>
            _sut.Notes.Values.Any(n => n.Id == "id-a") &&
            _sut.Notes.Values.Any(n => n.Id == "id-b")
                ? true
                : (bool?)null);

        Assert.Contains(_sut.Notes.Values, n => n.Id == "id-a");
        Assert.Contains(_sut.Notes.Values, n => n.Id == "id-b");
    }

    // ── Deleted ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileDeleted_RemovesNoteFromDict()
    {
        var noteDir = Path.Combine(_dir, "del-id");
        Directory.CreateDirectory(noteDir);
        var path = Path.Combine(noteDir, "note.md");
        File.WriteAllText(path, MakeRaw("del-id", "To Delete"));
        await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "del-id"));

        File.Delete(path);

        await PollUntilAsync(() =>
            _sut.Notes.Values.All(n => n.Id != "del-id") ? true : (bool?)null);

        Assert.DoesNotContain(_sut.Notes.Values, n => n.Id == "del-id");
    }

    // ── Changed ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileChanged_UpdatesNoteInDict()
    {
        var noteDir = Path.Combine(_dir, "upd-id");
        Directory.CreateDirectory(noteDir);
        var path = Path.Combine(noteDir, "note.md");
        File.WriteAllText(path, MakeRaw("upd-id", "Original"));
        await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "upd-id"));

        File.WriteAllText(path, MakeRaw("upd-id", "Updated"));

        var note = await PollUntilAsync(() =>
        {
            var n = _sut.Notes.Values.FirstOrDefault(v => v.Id == "upd-id");
            return n?.Title == "Updated" ? n : null;
        });

        Assert.NotNull(note);
        Assert.Equal("Updated", note.Title);
    }

    // ── Renamed ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task FileRenamedAwayFromNoteMd_RemovesNoteFromDict()
    {
        var noteDir   = Path.Combine(_dir, "ren-id");
        Directory.CreateDirectory(noteDir);
        var notePath    = Path.Combine(noteDir, "note.md");
        var renamedPath = Path.Combine(noteDir, "archived.md");
        File.WriteAllText(notePath, MakeRaw("ren-id", "Rename Me"));
        await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "ren-id"));

        File.Move(notePath, renamedPath);

        await PollUntilAsync(() =>
            _sut.Notes.Values.All(n => n.Id != "ren-id") ? true : (bool?)null);

        Assert.DoesNotContain(_sut.Notes.Values, n => n.Id == "ren-id");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string MakeRaw(string id, string title) =>
        $"---\nid: {id}\ntitle: \"{title}\"\ntags: []\npinned: false\ncolor: \"\"\n---\n";

    private static async Task<T> PollUntilAsync<T>(
        Func<T?> condition,
        int timeoutMs = 3000,
        int intervalMs = 50) where T : class
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var result = condition();
            if (result is not null) return result;
            await Task.Delay(intervalMs);
        }
        throw new TimeoutException($"Condition not met within {timeoutMs}ms.");
    }

    private static async Task<bool> PollUntilAsync(
        Func<bool?> condition,
        int timeoutMs = 3000,
        int intervalMs = 50)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (condition() is true) return true;
            await Task.Delay(intervalMs);
        }
        throw new TimeoutException($"Condition not met within {timeoutMs}ms.");
    }
}
