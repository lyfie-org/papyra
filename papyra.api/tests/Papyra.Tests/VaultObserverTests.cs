using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class VaultObserverTests
{
    private static VaultObserver NewObserver(string notesDir, out VaultState state, out WriteRing ring)
    {
        state = new VaultState();
        ring = new WriteRing(new MemoryCache(new MemoryCacheOptions()));
        var options = new VaultObserverOptions { NotesDir = notesDir, DebounceMs = 150 };
        return new VaultObserver(
            options, new MarkdownStorageService(), state, ring, NullLogger<VaultObserver>.Instance);
    }

    [Fact]
    public async Task RapidWrites_CollapseToSingleUpdate()
    {
        var dir = NewTempDir();
        var observer = NewObserver(dir, out var state, out _);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(dir, "note.md");

            for (var i = 0; i < 20; i++)
                await File.WriteAllTextAsync(path, $"---\nid: n1\ntitle: v{i}\n---\n\nbody {i}");

            await WaitUntil(() => observer.ProcessedEvents >= 1, 3000);
            await Task.Delay(300); // settle: prove no further flushes land

            Assert.Equal(1, observer.ProcessedEvents); // debounced to one update
            Assert.Equal(1, state.Count);
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
        var observer = NewObserver(dir, out var state, out _);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(dir, "hello.md");
            await File.WriteAllTextAsync(path, "---\nid: h1\ntitle: Hello\n---\n\nworld");

            await WaitUntil(() => state.Count >= 1, 3000);

            Assert.Equal(1, state.Count);
            Assert.Equal("Hello", state.Snapshot().Single().Title);
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
        var observer = NewObserver(dir, out var state, out var ring);
        try
        {
            await observer.StartAsync(default);
            var path = Path.Combine(dir, "self.md");
            ring.Mark(path); // Papyra logs its own write before touching disk
            await File.WriteAllTextAsync(path, "---\nid: s1\ntitle: Self\n---\n\nx");

            await Task.Delay(600); // > debounce; flush would have fired by now

            Assert.Equal(0, observer.ProcessedEvents); // echo ignored
            Assert.Equal(0, state.Count);
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

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-obs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
