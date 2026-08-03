using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace Papyra.Api.Storage;

// Read-it-later web archiver. When a note is saved with a URL in its body, this
// background-fetches the page, extracts the readable article (SmartReader), saves it
// as a Markdown sub-note in the user's media dir, and appends a "Saved" card to the
// note. Idempotent per URL (keyed by a hash filename) so re-saving a note doesn't
// re-fetch.
//
// SSRF-guarded: only http/https, every resolved IP must be publicly routable (no
// loopback/private/link-local/ULA/CGNAT/metadata), redirects are followed manually
// and re-validated each hop, and the response is size-capped.
public sealed partial class WebArchiverService : BackgroundService
{
    private const int MaxBytes = 5 * 1024 * 1024;   // 5 MiB response cap
    private const int MaxRedirects = 3;

    private static readonly HttpClient Http = CreateClient();

    private readonly Channel<Job> _queue = Channel.CreateUnbounded<Job>();
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.OrdinalIgnoreCase);

    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly VaultState _state;
    private readonly MarkdownStorageService _storage;
    private readonly WriteRing _writeRing;
    private readonly SearchIndexService _search;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<WebArchiverService> _logger;

    public WebArchiverService(
        IConfiguration config,
        IHostEnvironment env,
        VaultState state,
        MarkdownStorageService storage,
        WriteRing writeRing,
        SearchIndexService search,
        ILoggerFactory loggerFactory)
    {
        _config = config;
        _env = env;
        _state = state;
        _storage = storage;
        _writeRing = writeRing;
        _search = search;
        _loggerFactory = loggerFactory;
        _logger = loggerFactory.CreateLogger<WebArchiverService>();
    }

    private readonly record struct Job(string UserId, string NoteId, string Body);

    // Called from the note-write path; scans the body for URLs to archive.
    public void Enqueue(string userId, string noteId, string? body)
    {
        if (string.IsNullOrEmpty(body) || !body.Contains("http", StringComparison.OrdinalIgnoreCase)) return;
        _queue.Writer.TryWrite(new Job(userId, noteId, body));
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(ct))
        {
            try { await ProcessJobAsync(job, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Web archive job failed for note {NoteId}", job.NoteId); }
        }
    }

    private async Task ProcessJobAsync(Job job, CancellationToken ct)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, job.UserId);
        var guard = _loggerFactory.CreateLogger("PathGuard");

        foreach (var url in ExtractUrls(job.Body).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var fileName = ArchiveFileName(url);
            var archivePath = PathGuard.ResolveAndVerify(mediaDir, fileName, guard);
            if (File.Exists(archivePath)) continue; // already archived → idempotent

            var dedupeKey = $"{job.UserId}:{url}";
            if (!_inFlight.TryAdd(dedupeKey, 0)) continue;
            try
            {
                var html = await FetchAsync(url, ct);
                if (html is null) continue;

                var article = new SmartReader.Reader(url, html).GetArticle();
                if (article is null || !article.IsReadable)
                {
                    _logger.LogInformation("Archived {Url}: no readable article extracted, skipping.", url);
                    continue;
                }

                Directory.CreateDirectory(mediaDir);
                await WriteAtomicAsync(archivePath, BuildArchiveMarkdown(url, article), ct);
                AppendSavedCard(job.UserId, job.NoteId, BuildSavedCard(url, article), ct);
                _logger.LogInformation("Archived {Url} → {File}", url, fileName);
            }
            finally
            {
                _inFlight.TryRemove(dedupeKey, out _);
            }
        }
    }

    // SSRF-safe fetch: http(s) only, every resolved IP must be public, redirects
    // followed manually and re-validated, response size-capped, HTML only.
    private async Task<string?> FetchAsync(string url, CancellationToken ct)
    {
        var current = url;
        for (var hop = 0; hop <= MaxRedirects; hop++)
        {
            if (!Uri.TryCreate(current, UriKind.Absolute, out var uri)) return null;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
            if (!await HostIsPublicAsync(uri, ct))
            {
                _logger.LogWarning("Refusing to archive {Host}: resolves to a non-public address.", uri.Host);
                return null;
            }

            using var req = new HttpRequestMessage(HttpMethod.Get, uri);
            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

            if (IsRedirect(resp.StatusCode) && resp.Headers.Location is { } loc)
            {
                current = new Uri(uri, loc).ToString(); // re-validated on the next loop
                continue;
            }
            if (!resp.IsSuccessStatusCode) return null;

            var mediaType = resp.Content.Headers.ContentType?.MediaType;
            if (mediaType is not null && !mediaType.Contains("html", StringComparison.OrdinalIgnoreCase)) return null;

            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            return await ReadCappedAsync(stream, ct);
        }
        return null; // too many redirects
    }

    private static async Task<bool> HostIsPublicAsync(Uri uri, CancellationToken ct)
    {
        IPAddress[] ips;
        try { ips = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, ct); }
        catch { return false; }
        return ips.Length > 0 && ips.All(IsPubliclyRoutable);
    }

    private static async Task<string?> ReadCappedAsync(Stream stream, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (ms.Length + read > MaxBytes) break; // stop at the cap
            ms.Write(buffer, 0, read);
        }
        return ms.Length == 0 ? null : Encoding.UTF8.GetString(ms.ToArray());
    }

    // Append a "Saved" card to whichever note this job targets (mirrors the note
    // write path so caches stay consistent).
    private void AppendSavedCard(string userId, string noteId, string card, CancellationToken ct)
    {
        var path = _state.PathFor(userId, noteId);
        if (path is null || !_state.TryGet(userId, path, out var note) || note is null) return;

        note.Body = note.Body.TrimEnd() + "\n\n" + card + "\n";
        note.Updated = DateTime.UtcNow;
        _writeRing.Mark(path);
        _storage.WriteAsync(path, note, ct).GetAwaiter().GetResult();
        _state.Upsert(userId, path, note);
        _search.IndexNote(userId, note);
    }

    private static async Task WriteAtomicAsync(string destPath, string content, CancellationToken ct)
    {
        var tmp = destPath + $".{Guid.NewGuid():N}.tmp";
        await File.WriteAllTextAsync(tmp, content, ct);
        File.Move(tmp, destPath, overwrite: true);
    }

    private static HttpClient CreateClient()
    {
        // Manual redirects only, so each hop is SSRF-revalidated in FetchAsync.
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            AutomaticDecompression = DecompressionMethods.All,
        };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("PapyraWebArchiver/1.0");
        return client;
    }

    private static bool IsRedirect(HttpStatusCode code) =>
        code is HttpStatusCode.MovedPermanently or HttpStatusCode.Found
             or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect
             or HttpStatusCode.PermanentRedirect;

    // ── Pure, unit-testable helpers ─────────────────────────────────────────────

    [GeneratedRegex(@"https?://[^\s<>()\[\]""']+", RegexOptions.IgnoreCase)]
    private static partial Regex UrlRegex();

    internal static IEnumerable<string> ExtractUrls(string body)
    {
        foreach (Match m in UrlRegex().Matches(body ?? string.Empty))
            yield return m.Value.TrimEnd('.', ',', ';', ':', '!', '?', ')', '"', '\'');
    }

    // A stable per-URL filename so re-saving a note never re-archives the same page.
    internal static string ArchiveFileName(string url)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16].ToLowerInvariant();
        return $"archived-{hash}.md";
    }

    // Reject anything that isn't a public unicast address (SSRF defense).
    internal static bool IsPubliclyRoutable(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return false;

        var b = ip.GetAddressBytes();
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            if (b[0] is 0 or 10 or 127) return false;                 // "this", private, loopback
            if (b[0] == 169 && b[1] == 254) return false;             // link-local (incl. 169.254.169.254 metadata)
            if (b[0] == 172 && b[1] is >= 16 and <= 31) return false; // private
            if (b[0] == 192 && b[1] == 168) return false;             // private
            if (b[0] == 100 && b[1] is >= 64 and <= 127) return false;// CGNAT
            if (b[0] >= 224) return false;                            // multicast + reserved
            return true;
        }

        if (ip.IsIPv6LinkLocal || ip.IsIPv6Multicast || ip.IsIPv6SiteLocal) return false;
        if (IPAddress.IPv6Any.Equals(ip)) return false;
        if ((b[0] & 0xfe) == 0xfc) return false; // fc00::/7 unique-local
        return true;
    }

    internal static string BuildArchiveMarkdown(string url, SmartReader.Article article)
    {
        var author = string.IsNullOrWhiteSpace(article.Author) ? "" : $" · {article.Author.Trim()}";
        var date = article.PublicationDate is { } d ? $" · {d:yyyy-MM-dd}" : "";
        var title = string.IsNullOrWhiteSpace(article.Title) ? url : article.Title.Trim();
        return $"# {title}\n\n> Source: {url}{author}{date}\n\n{(article.TextContent ?? string.Empty).Trim()}\n";
    }

    internal static string BuildSavedCard(string url, SmartReader.Article article)
    {
        var title = string.IsNullOrWhiteSpace(article.Title) ? url : article.Title.Trim();
        var sb = new StringBuilder();
        sb.Append("> 📄 **Saved article** · [").Append(title).Append("](").Append(url).Append(")\n");
        var meta = new List<string>();
        if (!string.IsNullOrWhiteSpace(article.Author)) meta.Add(article.Author.Trim());
        if (article.PublicationDate is { } d) meta.Add(d.ToString("yyyy-MM-dd"));
        if (meta.Count > 0) sb.Append("> ").Append(string.Join(" · ", meta)).Append('\n');
        if (!string.IsNullOrWhiteSpace(article.Excerpt)) sb.Append("> ").Append(article.Excerpt.Trim()).Append('\n');
        return sb.ToString().TrimEnd();
    }
}
