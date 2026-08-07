using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
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
    private static VaultObserver NewObserver(string usersDir, out VaultState state, out WriteRing ring, out string notesDir)
    {
        state = new VaultState();
        ring = new WriteRing(new MemoryCache(new MemoryCacheOptions()));
        var options = new VaultObserverOptions { UsersDir = usersDir, DebounceMs = 150 };
        notesDir = options.UserNotesDir(Uid);
        Directory.CreateDirectory(notesDir);
        return new VaultObserver(
            options, new MarkdownStorageService(), state, ring, NullLogger<VaultObserver>.Instance);
    }

    [Fact]
    public async Task RapidWrites_CollapseToSingleUpdate()
    {
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _, out var notesDir);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(notesDir, "note.md");

            for (var i = 0; i < 20; i++)
                await File.WriteAllTextAsync(path, $"---\nid: n1\ntitle: v{i}\n---\n\nbody {i}");

            await WaitUntil(() => observer.ProcessedEvents >= 1, WaitTimeoutMs);
            await Task.Delay(300); // settle: prove no further flushes land

            Assert.Equal(1, observer.ProcessedEvents); // debounced to one update
            Assert.Equal(1, state.Count(Uid));
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
