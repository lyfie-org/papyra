using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Caching.Memory;

namespace Papyra.Api.Storage;

/// <summary>
/// What the editor and the cards need to lay an attachment out before it has
/// loaded: its kind, type, size and — for pictures and video — its shape. Also
/// the <see cref="Version"/> that makes derived URLs (thumbnails, posters)
/// immutable, so a browser can cache them for a year.
/// </summary>
public sealed record MediaMeta
{
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public required string Mime { get; init; }
    public long Size { get; init; }
    /// <summary>SHA-256 of the bytes, hex. Computed while an upload streams in;
    /// absent for files that predate it.</summary>
    public string? Hash { get; init; }
    /// <summary>Short content id for cache-busting derived URLs: the hash prefix,
    /// or size+mtime for files without one.</summary>
    public required string Version { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public long? DurationMs { get; init; }
    public bool Animated { get; init; }
    /// <summary>A still for a video, captured by the browser at upload.</summary>
    public bool Poster { get; init; }
    /// <summary>Whether <c>/thumb</c> can produce a WebP preview.</summary>
    public bool Thumb { get; init; }

    // Staleness check: the meta describes this exact file (not one that later
    // replaced it on disk by other means — a restore, a sync tool).
    [JsonInclude] internal long SourceTicks { get; init; }
}

/// <summary>Client-measured facts the server can't derive itself (no ffmpeg).</summary>
public sealed record MediaHints(int? Width, int? Height, long? DurationMs);

/// <summary>
/// Owns everything derived from a user's attachments, under
/// <c>users/{uid}/.papyra/media/</c> (see <see cref="PapyraPaths.UserMediaDerivedDir"/>):
/// <list type="bullet">
///   <item><c>{name}.meta.json</c> — <see cref="MediaMeta"/>; rebuilt on demand if missing or stale.</item>
///   <item><c>{name}.poster.webp|jpg|png</c> — a video's poster frame (not rebuildable).</item>
///   <item><c>thumbs/{version}-{w}.webp</c> — thumbnails, keyed by content so
///   identical files share them.</item>
/// </list>
/// The media files themselves are never touched.
/// </summary>
public sealed class MediaMetaStore(IConfiguration config, IHostEnvironment env, IMemoryCache cache, ILogger<MediaMetaStore> logger)
{
    /// <summary>Thumbnail widths. A request is snapped up to one of these so a caller can't mint endless variants.</summary>
    public static readonly int[] ThumbWidths = [160, 320, 640, 1280];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly string[] PosterExtensions = [".webp", ".jpg", ".png"];

    // One thumbnail render per (user, version, width) at a time: a grid of 50
    // cards asking for the same new thumb must not decode it 50 times.
    private static readonly Dictionary<string, SemaphoreSlim> Gates = new(StringComparer.Ordinal);

    private readonly string _contentRoot = env.ContentRootPath;

    public string DerivedDir(string uid) => PapyraPaths.UserMediaDerivedDir(config, _contentRoot, uid);

    private string MetaPath(string uid, string name) => Path.Combine(DerivedDir(uid), name + ".meta.json");

    /// <summary>The poster file for a video, if one was captured.</summary>
    public string? PosterPath(string uid, string name)
    {
        foreach (var ext in PosterExtensions)
        {
            var p = Path.Combine(DerivedDir(uid), name + ".poster" + ext);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    /// <summary>
    /// Meta for the file at <paramref name="mediaPath"/>, from memory, then disk,
    /// then derived afresh (never hashing — that happens only while an upload
    /// streams in). Null when the file doesn't exist.
    /// </summary>
    public MediaMeta? Get(string uid, string mediaPath)
    {
        var info = new FileInfo(mediaPath);
        if (!info.Exists) return null;
        var ticks = info.LastWriteTimeUtc.Ticks ^ info.Length;
        var key = CacheKey(uid, info.Name);
        if (cache.TryGetValue(key, out MediaMeta? hit) && hit is not null && hit.SourceTicks == ticks) return hit;

        var metaPath = MetaPath(uid, info.Name);
        MediaMeta? meta = null;
        try
        {
            if (File.Exists(metaPath))
            {
                var stored = JsonSerializer.Deserialize<MediaMeta>(File.ReadAllText(metaPath), Json);
                if (stored is not null && stored.SourceTicks == ticks && stored.Name == info.Name) meta = stored;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            logger.LogDebug(ex, "Unreadable media meta {Path}; rebuilding", metaPath);
        }

        if (meta is null)
        {
            // Keep what only the upload could know (hash, client hints) if the
            // stored meta is merely stale in its timestamp, e.g. after a restore.
            MediaMeta? previous = null;
            try { if (File.Exists(metaPath)) previous = JsonSerializer.Deserialize<MediaMeta>(File.ReadAllText(metaPath), Json); }
            catch (Exception ex) when (ex is IOException or JsonException) { }
            var keep = previous is not null && previous.Size == info.Length ? previous : null;
            meta = Derive(uid, info, keep?.Hash,
                keep is null ? null : new MediaHints(keep.Width, keep.Height, keep.DurationMs));
            Write(uid, meta);
        }

        cache.Set(key, meta, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromMinutes(30), Size = 1 });
        return meta;
    }

    /// <summary>Record meta for a just-stored upload (hash known, client hints clamped).</summary>
    public MediaMeta Record(string uid, string mediaPath, string hash, MediaHints? hints, bool hasPoster)
    {
        var info = new FileInfo(mediaPath);
        var meta = Derive(uid, info, hash, hints) with { Poster = hasPoster || PosterPath(uid, info.Name) is not null };
        Write(uid, meta);
        cache.Set(CacheKey(uid, info.Name), meta, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromMinutes(30), Size = 1 });
        return meta;
    }

    /// <summary>Store a video's poster frame (already sniffed as an image).</summary>
    public void SavePoster(string uid, string name, ReadOnlySpan<byte> bytes, string extension)
    {
        var dir = DerivedDir(uid);
        Directory.CreateDirectory(dir);
        foreach (var ext in PosterExtensions)
        {
            var old = Path.Combine(dir, name + ".poster" + ext);
            if (File.Exists(old)) File.Delete(old);
        }
        AtomicWrite(Path.Combine(dir, name + ".poster" + extension), bytes);
    }

    /// <summary>Snap a requested width to a bucket (clamped to the largest).</summary>
    public static int SnapWidth(int? requested)
    {
        var w = requested ?? 320;
        foreach (var bucket in ThumbWidths)
            if (w <= bucket) return bucket;
        return ThumbWidths[^1];
    }

    /// <summary>
    /// The path of a WebP thumbnail for this attachment at (snapped) width
    /// <paramref name="width"/>, rendering it once if needed. Pictures thumbnail
    /// themselves; a video thumbnails its poster. Null when there is nothing this
    /// server can render (SVG, HEIC, audio, documents, a video without a poster).
    /// </summary>
    public async Task<string?> ThumbnailAsync(string uid, string mediaPath, MediaMeta meta, int width, CancellationToken ct)
    {
        var source = meta.Kind switch
        {
            "image" or "gif" => mediaPath,
            "video" => PosterPath(uid, meta.Name),
            _ => null,
        };
        if (source is null || !ImageProcessor.CanDecode(source)) return null;

        var sourceVersion = source == mediaPath ? meta.Version : meta.Version + "p";
        var dest = Path.Combine(DerivedDir(uid), "thumbs", $"{sourceVersion}-{width}.webp");
        if (File.Exists(dest)) return dest;

        var gateKey = $"{uid}/{sourceVersion}/{width}";
        SemaphoreSlim gate;
        lock (Gates)
        {
            if (!Gates.TryGetValue(gateKey, out gate!)) Gates[gateKey] = gate = new SemaphoreSlim(1, 1);
        }
        await gate.WaitAsync(ct);
        try
        {
            if (File.Exists(dest)) return dest;
            var ok = await Task.Run(() => ImageProcessor.WriteThumbnail(source, width, dest), ct);
            return ok ? dest : null;
        }
        finally
        {
            gate.Release();
            lock (Gates)
            {
                if (gate.CurrentCount == 1) Gates.Remove(gateKey);
            }
        }
    }

    /// <summary>
    /// Forget an attachment's derived state (it was pruned). Its meta and poster
    /// travel with it to the trash; thumbnails are rebuilt on demand anyway.
    /// </summary>
    public void MoveDerivedTo(string uid, string name, string destinationDir)
    {
        cache.Remove(CacheKey(uid, name));
        var dir = DerivedDir(uid);
        if (!Directory.Exists(dir)) return;
        foreach (var file in Directory.EnumerateFiles(dir, name + ".*"))
        {
            var suffix = Path.GetFileName(file)[name.Length..];
            if (suffix is not (".meta.json" or ".poster.webp" or ".poster.jpg" or ".poster.png")) continue;
            Directory.CreateDirectory(destinationDir);
            File.Move(file, Path.Combine(destinationDir, Path.GetFileName(file)), overwrite: true);
        }
    }

    /// <summary>Delete thumbnails no remaining attachment uses. Returns how many went.</summary>
    public int SweepThumbnails(string uid, IReadOnlySet<string> liveVersions)
    {
        var thumbs = Path.Combine(DerivedDir(uid), "thumbs");
        if (!Directory.Exists(thumbs)) return 0;
        var removed = 0;
        foreach (var file in Directory.EnumerateFiles(thumbs, "*.webp"))
        {
            var stem = Path.GetFileNameWithoutExtension(file);
            var dash = stem.LastIndexOf('-');
            var version = dash > 0 ? stem[..dash] : stem;
            if (version.EndsWith('p')) version = version[..^1];
            if (liveVersions.Contains(version)) continue;
            try { File.Delete(file); removed++; } catch (IOException) { }
        }
        return removed;
    }

    private MediaMeta Derive(string uid, FileInfo info, string? hash, MediaHints? hints)
    {
        var kind = KindOf(info.Extension);
        var probe = kind is "image" or "gif" ? ImageProcessor.Probe(info.FullName) : null;
        var poster = PosterPath(uid, info.Name);
        // A video's shape: the browser measured it at upload; failing that, its poster.
        var posterProbe = kind == "video" && poster is not null && (hints?.Width is null || hints.Height is null)
            ? ImageProcessor.Probe(poster) : null;
        return new MediaMeta
        {
            Name = info.Name,
            Kind = kind,
            Mime = MediaResponder.ContentTypeFor(info.FullName),
            Size = info.Length,
            Hash = hash,
            Version = hash is { Length: >= 16 } ? hash[..16] : $"{info.Length:x}{info.LastWriteTimeUtc.Ticks:x}",
            Width = probe?.Width ?? Clamp(hints?.Width) ?? posterProbe?.Width,
            Height = probe?.Height ?? Clamp(hints?.Height) ?? posterProbe?.Height,
            DurationMs = kind is "video" or "audio" && hints?.DurationMs is > 0 and <= 86_400_000 ? hints.DurationMs : null,
            Animated = probe?.Animated ?? false,
            Poster = poster is not null,
            Thumb = kind is "image" or "gif" ? probe is not null : kind == "video" && poster is not null,
            SourceTicks = info.LastWriteTimeUtc.Ticks ^ info.Length,
        };
    }

    private static int? Clamp(int? px) => px is > 0 and <= 16384 ? px : null;

    /// <summary>The kind a stored attachment is, from the extension the server gave it.</summary>
    public static string KindOf(string extension) => extension.ToLowerInvariant() switch
    {
        ".gif" => "gif",
        ".png" or ".jpg" or ".jpeg" or ".webp" or ".avif" or ".bmp" or ".ico" or ".tif" or ".tiff"
            or ".heic" or ".heif" or ".svg" => "image",
        ".mp4" or ".m4v" or ".webm" or ".mov" or ".ogv" or ".mkv" or ".avi" => "video",
        ".mp3" or ".m4a" or ".aac" or ".wav" or ".ogg" or ".oga" or ".opus" or ".flac" or ".weba" => "audio",
        ".pdf" or ".doc" or ".docx" or ".xls" or ".xlsx" or ".ppt" or ".pptx" or ".odt" or ".ods" or ".odp"
            or ".rtf" or ".txt" or ".md" or ".csv" or ".tsv" or ".json" or ".log" or ".epub" or ".zip" => "document",
        _ => "file",
    };

    private void Write(string uid, MediaMeta meta)
    {
        try
        {
            Directory.CreateDirectory(DerivedDir(uid));
            AtomicWrite(MetaPath(uid, meta.Name), JsonSerializer.SerializeToUtf8Bytes(meta, Json));
        }
        catch (IOException ex)
        {
            // Derived state: failing to cache it costs a recompute, nothing more.
            logger.LogDebug(ex, "Could not write media meta for {Name}", meta.Name);
        }
    }

    private static void AtomicWrite(string path, ReadOnlySpan<byte> bytes)
    {
        var tmp = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                fs.Write(bytes);
                fs.Flush(true);
            }
            File.Move(tmp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    private static string CacheKey(string uid, string name) => $"media-meta:{uid}:{name}";
}
