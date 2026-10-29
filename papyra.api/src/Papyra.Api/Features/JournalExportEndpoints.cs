using System.IO.Compression;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

/// <summary>
/// <c>/api/export/journal</c> — the journal on its own, as Markdown files laid out the way they are stored
/// (<c>journal/yyyy/MM/yyyy-MM-dd.md</c>, with the pictures they use under <c>media/</c>) or as a PDF book.
/// Guarded exactly like the full export: <c>POST /api/export/authorize</c> (a code AND an open vault) earns a
/// one-time ticket, and the download spends it. Locked days leave readable — that is what the vault was
/// opened to allow — and the account gets an email saying so. A day in the Trash is not exported.
/// </summary>
public static partial class JournalExportEndpoints
{
    [GeneratedRegex(@"!\[\[(?<name>[^\]|#\r\n]+?\.[A-Za-z0-9]{2,5})(?:[#|][^\]\r\n]*)?\]\]")]
    private static partial Regex MediaEmbed();

    public static void MapJournalExport(this WebApplication app)
    {
        app.MapGet("/api/export/journal/summary", Summary).RequireAuthorization()
            .WithTags("Journal").WithSummary("What a journal export would hold")
            .WithDescription("The person only. Days with writing or a mood (none in the Trash), their words, and the first and last date.");
        app.MapGet("/api/export/journal", Export).RequireAuthorization()
            .WithTags("Journal").WithSummary("Download the journal as Markdown (zip) or a PDF book")
            .WithDescription("?format=md (default) or pdf, with a one-time ?ticket= from POST /api/export/authorize.");
    }

    private static bool IsKey(ClaimsPrincipal user) => user.Identity?.AuthenticationType == "ApiKey";

    private static IResult Summary(ClaimsPrincipal user, JournalService journal)
    {
        if (IsKey(user)) return Results.Json(new { error = "Exports need you signed in, not an API key.", code = "key_forbidden" }, statusCode: 403);
        var uid = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var days = journal.Summaries(uid, new DateOnly(1900, 1, 1), new DateOnly(9999, 12, 31))
            .Where(s => !s.Trashed && (s.Words > 0 || s.Mood is not null)).OrderBy(s => s.Date, StringComparer.Ordinal).ToList();
        return Results.Ok(new
        {
            days = days.Count,
            words = days.Sum(s => (long)s.Words),
            first = days.Count > 0 ? days[0].Date : null,
            last = days.Count > 0 ? days[^1].Date : null,
        });
    }

    private sealed record Day(DateOnly Date, string File, Note Note, bool Locked, string Raw);

    private static async Task<IResult> Export(
        string? ticket, string? format, ClaimsPrincipal user, HttpContext http, VaultState state,
        MarkdownStorageService storage, BlockAnchorCleanup anchors, ExportTicketStore tickets, AppDbContext db,
        EmailSender email, MediaMetaStore mediaMeta, IConfiguration config, IHostEnvironment env, ILoggerFactory lf, CancellationToken ct)
    {
        var uid = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
        // A format that is neither is refused before the ticket is spent.
        var pdf = string.Equals(format, "pdf", StringComparison.OrdinalIgnoreCase);
        if (!pdf && !string.IsNullOrEmpty(format) && !string.Equals(format, "md", StringComparison.OrdinalIgnoreCase))
            return Results.Json(new { error = "format is md or pdf.", code = "invalid" }, statusCode: 422);
        if (IsKey(user) || !tickets.Redeem(ticket, uid))
            return Results.Json(new { error = "Confirm with your code and vault first.", code = "ticket" }, statusCode: 403);

        var me = await db.Users.FindAsync([int.Parse(uid)], ct);
        var zone = TimeZoneInfo.Local;
        if (me?.TimeZone is { Length: > 0 } tzId && TimeZoneInfo.TryFindSystemTimeZoneById(tzId, out var chosen)) zone = chosen;
        var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, zone);

        // Every day that is not in the Trash, read from its file — locked ones decrypted (the vault is open).
        var days = new List<Day>();
        foreach (var entry in state.SnapshotJournal(uid))
        {
            if (entry.Trashed || !JournalPaths.TryDateFromId(entry.Id, out var date)) continue;
            var file = state.PathFor(uid, entry.Id);
            if (file is null || !File.Exists(file)) continue;
            var raw = await File.ReadAllTextAsync(file, ct);
            var note = storage.Deserialize(raw, file);
            days.Add(new Day(date, file, note, entry.Secure, entry.Secure ? storage.Serialize(note) : raw));
        }
        days.Sort((a, b) => a.Date.CompareTo(b.Date));
        if (pdf) days.RemoveAll(d => string.IsNullOrWhiteSpace(d.Note.Body) && JournalService.MoodOf(d.Note) is null);
        if (days.Count == 0)
            return Results.Json(new { error = "There are no journal days to export yet.", code = "empty" }, statusCode: 404);

        var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, uid);
        string? Locate(string name) => MediaEndpoints.Locate(mediaDir, name, lf);
        // What the book knows of an attachment: its file, size, length and a video's poster frame.
        BookMedia? Resolve(string name)
        {
            var path = Locate(name);
            if (path is null) return null;
            var meta = mediaMeta.Get(uid, path);
            return new BookMedia(path, meta?.Size ?? new FileInfo(path).Length, meta?.DurationMs, mediaMeta.PosterPath(uid, Path.GetFileName(path)));
        }

        var words = days.Sum(d => (long)JournalService.WordsOf(d.Note));
        if (me is not null && !string.IsNullOrWhiteSpace(me.Email))
        {
            var details = new List<EmailDetail>
            {
                new("Account", $"@{me.Username}"),
                new("When", $"{nowLocal:dddd d MMMM yyyy, HH:mm:ss} ({zone.Id})"),
                new("From IP address", http.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
                new("Browser / device", string.IsNullOrWhiteSpace(http.Request.Headers.UserAgent.ToString()) ? "unknown" : http.Request.Headers.UserAgent.ToString()),
                new("Confirmed with", "Code + vault unlock"),
                new("Format", pdf ? "PDF book" : "Markdown files (zip)"),
                new("Journal days", days.Count.ToString()),
                new("Locked days", days.Count(d => d.Locked).ToString()),
                new("Words", words.ToString("N0")),
                new("Server", email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}")),
            };
            email.NotifyInBackground(me, NotificationCatalog.ExportReady, "Your journal was exported",
                "Your Papyra journal — locked days included — was just downloaded.\n\n"
                + "If that was you, there's nothing to do. If it wasn't, change your password and vault PIN "
                + "straight away, and tell your Papyra administrator.",
                details);
        }

        if (pdf) return await PdfAsync(days, me, nowLocal, Resolve, ct);

        var keep = await anchors.InUseAsync(ct);
        var attached = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        DateTimeOffset InZone(DateTime utc)
        {
            var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), zone);
            if (local.Year < 1980) local = new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
            return new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), zone.GetUtcOffset(local));
        }

        return Results.Stream(body =>
        {
            var bodyControl = http.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpBodyControlFeature>();
            if (bodyControl is not null) bodyControl.AllowSynchronousIO = true;
            using (var zip = new ZipArchive(body, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var day in days)
                {
                    ct.ThrowIfCancellationRequested();
                    // Named by the date, as stored — a locked day's file on disk has an anonymous name.
                    var name = $"journal/{day.Date.Year:D4}/{day.Date.Month:D2}/{JournalClock.Format(day.Date)}.md";
                    var entry = zip.CreateEntry(name, CompressionLevel.Fastest);
                    entry.LastWriteTime = InZone(File.GetLastWriteTimeUtc(day.File));
                    using (var target = entry.Open())
                    {
                        var bytes = System.Text.Encoding.UTF8.GetBytes(BlockResolver.StripAnchors(day.Raw, keep));
                        target.Write(bytes, 0, bytes.Length);
                    }
                    foreach (Match m in MediaEmbed().Matches(day.Note.Body ?? string.Empty)) attached.Add(m.Groups["name"].Value.Trim());
                }
                // The pictures and recordings the days use, as the full export keeps them: media/<file>.
                foreach (var name in attached)
                {
                    var path = Locate(name);
                    if (path is null) continue;
                    var entry = zip.CreateEntry("media/" + Path.GetFileName(path), CompressionLevel.NoCompression);
                    entry.LastWriteTime = InZone(File.GetLastWriteTimeUtc(path));
                    using var target = entry.Open();
                    using var source = File.OpenRead(path);
                    source.CopyTo(target);
                }
            }
            return body.FlushAsync(ct);
        }, "application/zip", $"papyra-journal-{nowLocal:yyyy-MM-dd-HHmm}.zip");
    }

    private static async Task<IResult> PdfAsync(List<Day> days, User? me, DateTime nowLocal, Func<string, BookMedia?> locate, CancellationToken ct)
    {
        var book = days.Select(d => new BookDay(d.Date, JournalService.MoodOf(d.Note), d.Note.Body ?? string.Empty)).ToList();
        var author = me is null ? null : string.IsNullOrWhiteSpace(me.Name) ? me.Username : me.Name;
        // Built in a temp file (a long journal with pictures is big), streamed out and deleted as it closes.
        var tmp = Path.Combine(Path.GetTempPath(), $"papyra-journal-{Guid.NewGuid():N}.pdf");
        try
        {
            await Task.Run(() =>
            {
                using var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                JournalPdf.Write(fs, book, "Journal", author, locate);
            }, ct);
        }
        catch
        {
            if (File.Exists(tmp)) File.Delete(tmp);
            throw;
        }
        var stream = new FileStream(tmp, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.DeleteOnClose | FileOptions.SequentialScan);
        return Results.File(stream, "application/pdf", $"papyra-journal-{nowLocal:yyyy-MM-dd-HHmm}.pdf");
    }
}
