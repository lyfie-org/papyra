using System.Diagnostics;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Storage;

namespace Papyra.Tests;

[Collection(TimingSensitiveCollection.Name)]
public sealed class VaultObserverTests
{
    private const string Uid = "1";

    // Generous ceiling, not an expectation: WaitUntil returns as soon as the
    // condition holds, so this only matters on a loaded CI runner where the
    // debounce flush is scheduled late. The assertions after it stay exact.
    private const int WaitTimeoutMs = 15_000;

    // Build an observer over a users-root and pre-create tenant "1"'s notes dir so
    // StartAsync auto-discovers and watches it.
    private static VaultObserver NewObserver(
        string usersDir, out VaultState state, out WriteRing ring, out string notesDir, int debounceMs = 150)
    {
        state = new VaultState();
        ring = new WriteRing(new MemoryCache(new MemoryCacheOptions()));
        var options = new VaultObserverOptions { UsersDir = usersDir, DebounceMs = debounceMs };
        notesDir = options.UserNotesDir(Uid);
        Directory.CreateDirectory(notesDir);
        return new VaultObserver(
            options, new MarkdownStorageService(), state, ring, NullLogger<VaultObserver>.Instance);
    }

    [Fact]
    public async Task RapidWrites_CollapseToSingleUpdate()
    {
        // The debounce is a trailing window: a burst collapses to one flush only if
        // no gap between two writes exceeds it. At the production-like 150ms a
        // stalled CI runner (GC, a slow disk flush) occasionally paused longer than
        // that mid-loop and the burst legitimately became two flushes — the test was
        // measuring the runner, not the debounce. A 1s window is far wider than any
        // gap inside a 20-write loop, so this asserts the behaviour itself.
        const int debounceMs = 1000;
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _, out var notesDir, debounceMs);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "note.md");

            for (var i = 0; i < 20; i++)
                await File.WriteAllTextAsync(path, $"---\nid: n1\ntitle: v{i}\n---\n\nbody {i}");

            await WaitUntil(() => observer.ProcessedEvents >= 1, WaitTimeoutMs);
            // Settle for longer than a whole window, so a straggling watcher event
            // that would schedule a second flush has time to show up.
            await Task.Delay(debounceMs + 500);

            Assert.Equal(1, observer.ProcessedEvents); // debounced to one update
            Assert.Equal(1, state.Count(Uid));
            Assert.Equal("v19", state.Snapshot(Uid).Single().Title); // and it read the last write
        }
        finally
        {
            await observer.StopAsync(default);
            observer.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ExternalCreate_IsPickedUp()
    {
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _, out var notesDir);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "hello.md");
            const string content = "---\nid: h1\ntitle: Hello\n---\n\nworld";

            // Arming a FileSystemWatcher isn't instantaneous — on Linux the inotify
            // watch is registered slightly after EnableRaisingEvents returns, so a
            // single write issued right away can land before the watch exists and be
            // missed with no retry. (That's why RapidWrites, which writes 20 times,
            // is reliable while this test was not.) Re-emit until the observer sees
            // it: rewriting the same content is idempotent — the note is keyed by
            // path, so the assertions below stay exact.
            await WaitUntil(async () =>
            {
                await File.WriteAllTextAsync(path, content);
                return state.Count(Uid) >= 1;
            }, WaitTimeoutMs);

            Assert.Equal(1, state.Count(Uid));
            Assert.Equal("Hello", state.Snapshot(Uid).Single().Title);
        }
        finally
        {
            await observer.StopAsync(default);
            observer.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task SelfWrite_IsIgnored()
    {
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out var ring, out var notesDir);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "self.md");
            ring.Mark(path); // Papyra logs its own write before touching disk
            await File.WriteAllTextAsync(path, "---\nid: s1\ntitle: Self\n---\n\nx");

            await Task.Delay(600); // > debounce; flush would have fired by now

            Assert.Equal(0, observer.ProcessedEvents); // echo ignored
            Assert.Equal(0, state.Count(Uid));
        }
        finally
        {
            await observer.StopAsync(default);
            observer.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ExternalCreate_WithoutAnId_IsAdopted_AndTheIdWrittenBack()
    {
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _, out var notesDir);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "made-in-obsidian.md");
            const string content = "# Made in Obsidian\n\nNo frontmatter at all.\n";
            var expectedId = ForeignNoteAdopter.DeriveId(notesDir, path, _ => false);

            // Re-emit until seen (see ExternalCreate_IsPickedUp); the id is a
            // function of the path, so every round adopts it identically.
            await WaitUntil(async () =>
            {
                if (state.Count(Uid) == 0) await File.WriteAllTextAsync(path, content);
                return state.Count(Uid) >= 1;
            }, WaitTimeoutMs);
            await WaitUntil(() => ReadShared(path).StartsWith("---"), WaitTimeoutMs);

            var note = Assert.Single(state.Snapshot(Uid));
            Assert.Equal(expectedId, note.Id);           // was "" — listed, but unaddressable
            Assert.Equal("Made in Obsidian", note.Title); // was ""
            Assert.Equal($"---\nid: '{expectedId}'\n---\n\n{content}", File.ReadAllText(path));
        }
        finally
        {
            await observer.StopAsync(default);
            observer.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ExternalSave_ThatDropsTheId_KeepsTheNotesId()
    {
        // An editor holding a stale buffer saves over the file without its `id:`.
        // The note must stay the same note — shares, comments and links key on it.
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _, out var notesDir);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "kept.md");
            await WaitUntil(async () =>
            {
                if (state.Count(Uid) == 0) await File.WriteAllTextAsync(path, "---\nid: keep1\ntitle: Kept\n---\n\nv1");
                return state.Count(Uid) >= 1;
            }, WaitTimeoutMs);

            await File.WriteAllTextAsync(path, "v2 from another editor");
            await WaitUntil(() => ReadShared(path).Contains("id:"), WaitTimeoutMs);
            await WaitUntil(() => state.Snapshot(Uid).Single().Body.Contains("v2"), WaitTimeoutMs);

            var note = Assert.Single(state.Snapshot(Uid));
            Assert.Equal("keep1", note.Id);
            Assert.StartsWith("---\nid: 'keep1'\n", File.ReadAllText(path));
        }
        finally
        {
            await observer.StopAsync(default);
            observer.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task WatchedNote_DeletedWhileStopped_IsGoneFromSearchAfterRestart()
    {
        // The reported sequence: API running → another tool creates a note → the
        // watcher indexes it → API stops → the file is deleted → API starts. The
        // cold-boot diff used to prune only by NoteCache rows, which the watcher
        // never wrote, so search kept returning the deleted note.
        var dir = NewTempDir();
        var indexDir = NewTempDir();
        using var conn = new SqliteConnection("DataSource=:memory:");
        conn.Open(); // one in-memory database shared by every scope
        using var services = new ServiceCollection()
            .AddDbContext<AppDbContext>(o => o.UseSqlite(conn))
            .BuildServiceProvider();
        using (var setup = services.CreateScope())
            setup.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();
        var scopes = services.GetRequiredService<IServiceScopeFactory>();

        var options = new VaultObserverOptions { UsersDir = dir, DebounceMs = 150 };
        var notesDir = options.UserNotesDir(Uid);
        Directory.CreateDirectory(notesDir);
        var path = Path.Combine(notesDir, "delete-me-later.md");
        var search = new SearchIndexService(indexDir);
        var observer = new VaultObserver(
            options, new MarkdownStorageService(), new VaultState(),
            new WriteRing(new MemoryCache(new MemoryCacheOptions())),
            NullLogger<VaultObserver>.Instance, search: search, scopes: scopes);
        try
        {
            // Running: the watcher picks the note up, indexes it and caches it.
            await observer.StartAsync(default);
            // Re-emit until seen (see ExternalCreate_IsPickedUp).
            await WaitUntil(async () =>
            {
                if (await CachedAsync(scopes, "delete-me-later")) return true;
                await File.WriteAllTextAsync(path, "---\nid: delete-me-later\ntitle: Delete me later\n---\n\nscratch");
                return false;
            }, WaitTimeoutMs);
            Assert.Equal("delete-me-later", search.Search(Uid, "delete").Single().Id);
            Assert.True(await CachedAsync(scopes, "delete-me-later")); // the watcher kept the cache

            // Stopped: the file goes while nothing is watching.
            await observer.StopAsync(default);
            observer.Dispose();
            search.Dispose();
            File.Delete(path);

            // Started again: the cold-boot diff reconciles against disk.
            search = new SearchIndexService(indexDir);
            using (var scope = scopes.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await new ColdBootDiffService(
                        options, new MarkdownStorageService(), new VaultState(), search,
                        scopes, NullLogger<ColdBootDiffService>.Instance)
                    .RunDiffAsync(db, default);
            }

            Assert.Empty(search.Search(Uid, "delete"));
            Assert.False(await CachedAsync(scopes, "delete-me-later"));
        }
        finally
        {
            observer.Dispose();
            search.Dispose(); // release write.lock before deleting the index dir
            Directory.Delete(dir, recursive: true);
            Directory.Delete(indexDir, recursive: true);
        }
    }

    private static async Task<bool> CachedAsync(IServiceScopeFactory scopes, string noteId)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.NoteCache.FindAsync(Uid, noteId) is not null;
    }

    // The observer may be mid-replace on the file while a test polls it.
    private static string ReadShared(string path)
    {
        try { return File.ReadAllText(path); }
        catch (IOException) { return string.Empty; }
        catch (UnauthorizedAccessException) { return string.Empty; } // Windows, during File.Replace
    }

    private static async Task WaitUntil(Func<bool> cond, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (!cond() && sw.ElapsedMilliseconds < timeoutMs) await Task.Delay(25);
    }

    // Async variant for conditions that also nudge the system (e.g. re-writing a
    // file until the watcher reports it). Polls slower, since each attempt does I/O.
    private static async Task WaitUntil(Func<Task<bool>> cond, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (!await cond() && sw.ElapsedMilliseconds < timeoutMs) await Task.Delay(200);
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-obs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
