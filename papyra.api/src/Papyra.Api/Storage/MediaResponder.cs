using Microsoft.Net.Http.Headers;

namespace Papyra.Api.Storage;

/// <summary>
/// The one place attachments are handed back to a browser. Uploads are served
/// from Papyra's own origin, so how they are served is a security boundary:
/// <list type="bullet">
///   <item>The content type comes from a closed map keyed on the stored extension
///   (which the server chose — see <see cref="MediaSniffer"/>). Nothing is guessed.</item>
///   <item>Only kinds that cannot run script render inline: raster images, audio,
///   video, PDF, plain text. Everything else is a download.</item>
///   <item>Every non-PDF response replaces the app CSP with a sandboxed, script-free
///   one, so even a document opened directly in a tab (an SVG, a legacy .html
///   written before uploads were sniffed) gets an opaque origin and no script.</item>
/// </list>
/// </summary>
public static class MediaResponder
{
    private enum Mode { Inline, InlineSandboxed, Download }

    private sealed record Spec(string ContentType, Mode Mode);

    private static readonly Dictionary<string, Spec> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        // Raster images — inert.
        [".png"] = new("image/png", Mode.Inline),
        [".jpg"] = new("image/jpeg", Mode.Inline),
        [".jpeg"] = new("image/jpeg", Mode.Inline),
        [".gif"] = new("image/gif", Mode.Inline),
        [".webp"] = new("image/webp", Mode.Inline),
        [".avif"] = new("image/avif", Mode.Inline),
        [".bmp"] = new("image/bmp", Mode.Inline),
        [".ico"] = new("image/x-icon", Mode.Inline),
        [".tif"] = new("image/tiff", Mode.Inline),
        [".tiff"] = new("image/tiff", Mode.Inline),
        [".heic"] = new("image/heic", Mode.Inline),
        [".heif"] = new("image/heif", Mode.Inline),
        // SVG can carry script — harmless inside <img>, not when opened directly.
        [".svg"] = new("image/svg+xml", Mode.InlineSandboxed),
        // Audio / video.
        [".mp3"] = new("audio/mpeg", Mode.Inline),
        [".m4a"] = new("audio/mp4", Mode.Inline),
        [".aac"] = new("audio/aac", Mode.Inline),
        [".wav"] = new("audio/wav", Mode.Inline),
        [".ogg"] = new("audio/ogg", Mode.Inline),
        [".oga"] = new("audio/ogg", Mode.Inline),
        [".opus"] = new("audio/ogg", Mode.Inline),
        [".flac"] = new("audio/flac", Mode.Inline),
        [".weba"] = new("audio/webm", Mode.Inline),
        [".mp4"] = new("video/mp4", Mode.Inline),
        [".m4v"] = new("video/mp4", Mode.Inline),
        [".webm"] = new("video/webm", Mode.Inline),
        [".mov"] = new("video/quicktime", Mode.Inline),
        [".ogv"] = new("video/ogg", Mode.Inline),
        [".mkv"] = new("video/x-matroska", Mode.Inline),
        [".avi"] = new("video/x-msvideo", Mode.Inline),
        // PDF renders in the browser's own viewer, which a sandbox CSP would block.
        [".pdf"] = new("application/pdf", Mode.Inline),
        // Plain text is readable in a tab; nosniff + sandbox keep it text.
        [".txt"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        [".md"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        [".csv"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        [".tsv"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        [".log"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        [".json"] = new("text/plain; charset=utf-8", Mode.InlineSandboxed),
        // Documents and archives — downloads, typed so the OS opens the right app.
        [".docx"] = new("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Mode.Download),
        [".xlsx"] = new("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Mode.Download),
        [".pptx"] = new("application/vnd.openxmlformats-officedocument.presentationml.presentation", Mode.Download),
        [".doc"] = new("application/msword", Mode.Download),
        [".xls"] = new("application/vnd.ms-excel", Mode.Download),
        [".ppt"] = new("application/vnd.ms-powerpoint", Mode.Download),
        [".msg"] = new("application/vnd.ms-outlook", Mode.Download),
        [".odt"] = new("application/vnd.oasis.opendocument.text", Mode.Download),
        [".ods"] = new("application/vnd.oasis.opendocument.spreadsheet", Mode.Download),
        [".odp"] = new("application/vnd.oasis.opendocument.presentation", Mode.Download),
        [".epub"] = new("application/epub+zip", Mode.Download),
        [".rtf"] = new("application/rtf", Mode.Download),
        [".zip"] = new("application/zip", Mode.Download),
        [".7z"] = new("application/x-7z-compressed", Mode.Download),
        [".rar"] = new("application/vnd.rar", Mode.Download),
        [".gz"] = new("application/gzip", Mode.Download),
        [".tgz"] = new("application/gzip", Mode.Download),
    };

    // No script, no plugins, no forms, opaque origin. Images/media the document
    // itself loads (a direct image or video view) are still allowed.
    public const string SandboxPolicy =
        "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

    /// <summary>The content type the file will be served as.</summary>
    public static string ContentTypeFor(string path) =>
        Types.TryGetValue(Path.GetExtension(path), out var spec) ? spec.ContentType : "application/octet-stream";

    /// <summary>True when the file renders in the page rather than downloading.</summary>
    public static bool IsInline(string path) =>
        Types.TryGetValue(Path.GetExtension(path), out var spec) && spec.Mode != Mode.Download;

    /// <summary>
    /// Serve <paramref name="path"/> with the headers above. <paramref name="cacheControl"/>
    /// is the caller's: owner media can be cached briefly; shared or vault-gated
    /// media is revalidated every time so a revoked link or a re-locked vault
    /// takes effect.
    /// </summary>
    public static IResult Serve(HttpResponse response, string path, string cacheControl)
    {
        var info = new FileInfo(path);
        var spec = Types.TryGetValue(info.Extension, out var known)
            ? known
            // Unknown or legacy (.html/.js/.xml written before uploads were
            // sniffed): an opaque download, never content.
            : new Spec("application/octet-stream", Mode.Download);

        var headers = response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.CacheControl = cacheControl;
        if (spec.Mode != Mode.Inline || spec.ContentType != "application/pdf")
            headers.ContentSecurityPolicy = SandboxPolicy;
        if (spec.Mode == Mode.Download)
        {
            headers.ContentDisposition = new ContentDispositionHeaderValue("attachment")
            {
                FileNameStar = info.Name,
            }.ToString();
        }

        return FileResult(info, spec.ContentType);
    }

    /// <summary>
    /// The one framing carve-out: the browser's PDF viewer inside Papyra's own
    /// page. Everything else keeps <c>frame-ancestors 'none'</c>. A sandbox CSP
    /// would stop the viewer from running, so the isolation here is the type
    /// (PDF only — the server chose the extension from the bytes), nosniff, and
    /// a policy that lets the document load nothing beyond itself.
    /// </summary>
    public const string PdfViewPolicy =
        "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'";

    public static bool IsPdf(string path) =>
        string.Equals(Path.GetExtension(path), ".pdf", StringComparison.OrdinalIgnoreCase);

    /// <summary>Serve a PDF for an in-app viewer frame; anything else is 415.</summary>
    public static IResult ServePdfView(HttpResponse response, string path, string cacheControl)
    {
        if (!IsPdf(path))
            return Results.Json(new { error = "Only PDFs open in the viewer." }, statusCode: StatusCodes.Status415UnsupportedMediaType);
        var info = new FileInfo(path);
        var headers = response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.CacheControl = cacheControl;
        headers.XFrameOptions = "SAMEORIGIN";
        headers.ContentSecurityPolicy = PdfViewPolicy;
        headers.ContentDisposition = new ContentDispositionHeaderValue("inline") { FileNameStar = info.Name }.ToString();
        return FileResult(info, "application/pdf");
    }

    private static IResult FileResult(FileInfo info, string contentType)
    {
        // Stored names never change content (every upload gets a fresh name), so
        // size + mtime is a sound validator until content hashes arrive.
        var modified = info.LastWriteTimeUtc;
        var etag = new EntityTagHeaderValue($"\"{info.Length:x}-{modified.Ticks:x}\"");
        return Results.File(info.FullName, contentType,
            lastModified: modified, entityTag: etag, enableRangeProcessing: true);
    }
}
