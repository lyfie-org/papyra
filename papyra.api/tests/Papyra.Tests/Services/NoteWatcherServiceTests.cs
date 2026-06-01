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
    public async Task StartAsync_LoadsExistingMdFiles()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "pre.md"), MakeRaw("pre-id", "Pre Note"));

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
    public async Task StartAsync_IgnoresNonMdFiles()
    {
        var dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "ignore.txt"), "plain text");

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
        var path = Path.Combine(_dir, "new.md");
        File.WriteAllText(path, MakeRaw("note-1", "Created Note"));

        var note = await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "note-1"));

        Assert.NotNull(note);
        Assert.Equal("Created Note", note.Title);
    }

    [Fact]
    public async Task MultipleFilesCreated_AllAddedToDict()
    {
        File.WriteAllText(Path.Combine(_dir, "a.md"), MakeRaw("id-a", "Alpha"));
        File.WriteAllText(Path.Combine(_dir, "b.md"), MakeRaw("id-b", "Beta"));

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
        var path = Path.Combine(_dir, "del.md");
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
        var path = Path.Combine(_dir, "upd.md");
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
    public async Task FileRenamed_OldPathRemovedNewPathAdded()
    {
        var oldPath = Path.Combine(_dir, "old.md");
        var newPath = Path.Combine(_dir, "renamed.md");
        File.WriteAllText(oldPath, MakeRaw("ren-id", "Rename Me"));
        await PollUntilAsync(() => _sut.Notes.Values.FirstOrDefault(n => n.Id == "ren-id"));

        File.Move(oldPath, newPath);

        await PollUntilAsync(() =>
            _sut.Notes.ContainsKey(newPath) ? true : (bool?)null);

        Assert.False(_sut.Notes.ContainsKey(oldPath));
        Assert.True(_sut.Notes.ContainsKey(newPath));
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
