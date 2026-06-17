using Microsoft.Extensions.Caching.Memory;

namespace Papyra.Api.Storage;

// Loop prevention: Papyra logs every path it atomically writes here, so the
// FileSystemWatcher can ignore the echo of its own writes instead of re-parsing
// and re-broadcasting them (an infinite API↔disk loop). 500ms sliding window —
// long enough to cover an atomic tmp→replace, short enough not to swallow a real
// external edit that lands moments later. Registered as a singleton.
public sealed class WriteRing
{
    private static readonly TimeSpan Window = TimeSpan.FromMilliseconds(500);

    private readonly IMemoryCache _cache;

    public WriteRing(IMemoryCache cache) => _cache = cache;

    public void Mark(string path) =>
        _cache.Set(Key(path), true, new MemoryCacheEntryOptions { SlidingExpiration = Window });

    public bool IsSelfWrite(string path) => _cache.TryGetValue(Key(path), out _);

    private static string Key(string path) => "writering:" + Path.GetFullPath(path);
}
