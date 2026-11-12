using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Papyra.Api.Collab;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

/// <summary>
/// "Download .md" for one note. A note names its pictures and files only by name
/// (<c>![[image-db412d.png]]</c>), so a bare .md would arrive with every embed
/// broken. A note with no attachments is still a plain <c>.md</c>; one with any
/// is a zip holding <c>&lt;Title&gt;.md</c> and the files under <c>media/</c>,
/// laid out as the full export lays them out.
///
/// Built here rather than in the browser so the attachments are found by the same
/// parser the share and vault rules use, and each route applies its own access:
/// an owner reads their own unlocked notes; a person a note is shared with gets
/// only the files that note embeds, and nothing once the share ends or the note
/// is locked.
/// </summary>
public static partial class NoteExportEndpoints
{
    [GeneratedRegex(@"[\\/:*?""<>|\p{Cc}]+")]
    private static partial Regex UnsafeNameChars();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    public static void MapNoteExport(this WebApplication app)
    {
        app.MapGet("/api/notes/{id}/export", OwnAsync).RequireAuthorization()
            .WithTags("Notes").WithSummary("Download one note")
            .WithDescription("The note as Markdown, or a zip of the Markdown and its attachments (media/) when it embeds any. Locked notes are refused.");
        app.MapGet("/api/shares/incoming/{shareId:int}/export", SharedAsync).RequireAuthorization()
            .WithTags("Sharing").WithSummary("Download a note shared with you")
            .WithDescription("As the owner's download, with your own tags. Only the attachments that note embeds.");
    }

    private static async Task<IResult> OwnAsync(
        string id, ClaimsPrincipal user, HttpContext http, VaultState state, MarkdownStorageService storage,
        ICollabEngine collab, BlockAnchorCleanup anchors, IConfiguration config, IHostEnvironment env,
        ILoggerFactory lf, CancellationToken ct)
    {
        var uid = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
        if (state.PathFor(uid, id) is null) return Results.NotFound();
        // A note open live has what's typed saved first, as a plain read does.
        if (await collab.IsRoomActiveAsync(uid, id, ct)) await collab.FlushAsync(uid, id, ct);
        var path = state.PathFor(uid, id);
        var note = path is null ? null : await storage.ReadAsync(path, ct);
        if (note is null) return Results.NotFound();
        if (note.Secure)
            return Results.Json(new { error = "Unlock required.", code = "locked" }, statusCode: StatusCodes.Status401Unauthorized);

        var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, uid);
        var files = Attachments(note.Body, name => MediaEndpoints.Locate(mediaDir, name, lf));
        return Respond(http, note.Title, await MarkdownAsync(note, note.Tags, note.Color, note.Kind, anchors, ct), files, ct);
    }

    private static async Task<IResult> SharedAsync(
        int shareId, HttpContext http, SharedMedia shared, BlockAnchorCleanup anchors, CancellationToken ct)
    {
        var (share, note, error) = await shared.GrantNoteAsync(shareId, http, ct);
        if (error is not null) return error;

        // The owner's note, with your tags (the owner's are theirs). Each file is
        // resolved through the grant, so only what this note embeds is handed out.
        var paths = new List<string>();
        foreach (var name in MediaRefParser.Extract(note!.Body))
            if ((await shared.ByGrantAsync(shareId, name, http, ct)).Path is { } path) paths.Add(path);
        var files = Attachments(paths);
        var tags = ShareTags.Read(share!.GranteeTags);
        return Respond(http, note.Title, await MarkdownAsync(note, tags, note.Color, "note", anchors, ct), files, ct);
    }

    /// <summary>The .md Papyra would write: front matter, then the body — minus unused block markers.</summary>
    private static async Task<string> MarkdownAsync(
        Note note, IReadOnlyList<string> tags, string? color, string kind, BlockAnchorCleanup anchors, CancellationToken ct)
    {
        static string Q(string s) => JsonSerializer.Serialize(s, Quoted);
        var front = new List<string> { "---", $"title: {Q(note.Title)}" };
        if (tags.Count > 0) front.Add($"tags: [{string.Join(", ", tags.Select(Q))}]");
        if (!string.IsNullOrEmpty(color)) front.Add($"color: {Q(color)}");
        if (!string.IsNullOrEmpty(kind) && kind != "note") front.Add($"kind: {kind}");
        front.Add("---");
        front.Add("");
        var keep = await anchors.InUseAsync(ct);
        return string.Join('\n', front) + BlockResolver.StripAnchors(note.Body ?? string.Empty, keep);
    }

    private static readonly JsonSerializerOptions Quoted = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The files a body embeds that exist, one per file name (case-insensitive).</summary>
    private static List<string> Attachments(string? body, Func<string, string?> locate) =>
        Attachments(MediaRefParser.Extract(body).Select(locate).OfType<string>());

    private static List<string> Attachments(IEnumerable<string> paths)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return paths.Where(p => seen.Add(Path.GetFileName(p))).ToList();
    }

    private static IResult Respond(HttpContext http, string title, string markdown, List<string> files, CancellationToken ct)
    {
        var baseName = FileBase(title);
        var bytes = Encoding.UTF8.GetBytes(markdown);
        if (files.Count == 0) return Results.File(bytes, "text/markdown; charset=utf-8", baseName + ".md");

        return Results.Stream(body =>
        {
            // ZipArchive writes synchronously; allow it for this response only.
            var bodyControl = http.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpBodyControlFeature>();
            if (bodyControl is not null) bodyControl.AllowSynchronousIO = true;
            using (var zip = new ZipArchive(body, ZipArchiveMode.Create, leaveOpen: true))
            {
                var note = zip.CreateEntry(baseName + ".md", CompressionLevel.Fastest);
                using (var target = note.Open()) target.Write(bytes, 0, bytes.Length);
                foreach (var path in files)
                {
                    ct.ThrowIfCancellationRequested();
                    if (!File.Exists(path)) continue; // gone since the count: skipped
                    // Pictures, video and PDFs are already compressed: stored as they are.
                    var entry = zip.CreateEntry("media/" + Path.GetFileName(path), CompressionLevel.NoCompression);
                    using var target = entry.Open();
                    using var source = File.OpenRead(path);
                    source.CopyTo(target);
                }
            }
            return body.FlushAsync(ct);
        }, "application/zip", baseName + ".zip");
    }

    /// <summary>The title as a file name: no path or reserved characters, one space between words, at most 80 long.</summary>
    internal static string FileBase(string? title)
    {
        var name = Spaces().Replace(UnsafeNameChars().Replace(title ?? string.Empty, " "), " ").Trim();
        if (name.Length > 80) name = name[..80].TrimEnd();
        return name.Length == 0 ? "Untitled" : name;
    }
}
