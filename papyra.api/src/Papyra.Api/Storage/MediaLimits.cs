namespace Papyra.Api.Storage;

/// <summary>
/// How big an attachment may be, by kind. Deliberately roomy for pictures —
/// full-resolution phone photos, long GIFs — and firm for the kinds that can
/// quietly eat a disk (video, big documents).
/// </summary>
public static class MediaLimits
{
    private const long MB = 1024 * 1024;

    public const long Image = 30 * MB;
    public const long Gif = 50 * MB;
    public const long Audio = 100 * MB;
    public const long Video = 500 * MB;
    public const long Document = 100 * MB;
    public const long Other = 50 * MB;
    public const long Largest = Video;

    private static readonly HashSet<string> ImageExt = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp", ".svg", ".heic", ".heif", ".ico", ".tif", ".tiff" };
    private static readonly HashSet<string> AudioExt = new(StringComparer.OrdinalIgnoreCase)
        { ".mp3", ".m4a", ".wav", ".ogg", ".oga", ".flac", ".aac", ".opus" };
    private static readonly HashSet<string> VideoExt = new(StringComparer.OrdinalIgnoreCase)
        { ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv", ".avi" };
    private static readonly HashSet<string> DocExt = new(StringComparer.OrdinalIgnoreCase)
        { ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".txt", ".md", ".csv", ".epub", ".zip" };

    /// <summary>The kind's name (for the error message) and its byte limit.</summary>
    public static (string Kind, long Limit) For(string? fileName)
    {
        var ext = Path.GetExtension(fileName ?? string.Empty);
        if (string.Equals(ext, ".gif", StringComparison.OrdinalIgnoreCase)) return ("GIF", Gif);
        if (ImageExt.Contains(ext)) return ("image", Image);
        if (VideoExt.Contains(ext)) return ("video", Video);
        if (AudioExt.Contains(ext)) return ("audio file", Audio);
        if (DocExt.Contains(ext)) return ("document", Document);
        return ("file", Other);
    }

    /// <summary>
    /// The label and limit for a kind <see cref="MediaSniffer"/> decided from the
    /// bytes — what the upload path enforces, so renaming a file to .mp4 can't
    /// borrow the video allowance.
    /// </summary>
    public static (string Kind, long Limit) ForKind(string kind) => kind switch
    {
        "gif" => ("GIF", Gif),
        "image" => ("image", Image),
        "video" => ("video", Video),
        "audio" => ("audio file", Audio),
        "document" => ("document", Document),
        _ => ("file", Other),
    };

    /// <summary>
    /// The limits and the extension → kind table, for the web app to refuse an
    /// oversized file before uploading it (same numbers, one source). The server
    /// still decides by the sniffed bytes; this is only the early, friendly no.
    /// </summary>
    public static object Describe() => new
    {
        limits = new { image = Image, gif = Gif, audio = Audio, video = Video, document = Document, other = Other },
        extensions = new
        {
            image = ImageExt.Order(StringComparer.Ordinal).ToArray(),
            audio = AudioExt.Order(StringComparer.Ordinal).ToArray(),
            video = VideoExt.Order(StringComparer.Ordinal).ToArray(),
            document = DocExt.Order(StringComparer.Ordinal).ToArray(),
        },
    };

    public static string Human(long bytes) =>
        bytes >= MB ? $"{bytes / (double)MB:0.#} MB" : $"{Math.Max(1, bytes / 1024)} KB";
}
