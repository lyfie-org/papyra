using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace Papyra.Api.Storage;

/// <summary>
/// What a link someone wants to embed turned out to be.
/// <c>FinalUrl</c> is where it lands after redirects (a <c>maps.app.goo.gl</c>
/// short link → the full Google Maps link, which the browser knows how to
/// embed). <c>Frameable</c> is whether the site allows being shown in a frame
/// at all; <c>EmbedSrc</c> is the page's own embeddable player (from oEmbed),
/// when it has one.
/// </summary>
public sealed record EmbedResolution(
    string Url,
    string FinalUrl,
    bool Frameable,
    string? EmbedSrc,
    int? Width,
    int? Height,
    string? Title);

/// <summary>
/// Makes "Embed a link" work with the link people actually have. The browser
/// turns the well-known ones (maps, videos, songs, documents) into their
/// embeddable form on its own; everything else comes here, fetched by the
/// server through the same SSRF-guarded client as link previews — public
/// addresses only, every redirect re-checked, responses size-capped:
///
/// - short links are followed to where they land;
/// - a page that publishes oEmbed gets its own player;
/// - a page that forbids framing (<c>X-Frame-Options</c>, CSP
///   <c>frame-ancestors</c>) is reported, so the note shows a link card
///   instead of a frame that says "refused to connect".
///
/// Results are cached for an hour.
/// </summary>
public sealed partial class EmbedResolverService
{
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(1);

    private readonly IMemoryCache _cache;
    private readonly ILogger<EmbedResolverService> _logger;

    /// <summary>The page probe; tests replace it (no network).</summary>
    internal Func<string, CancellationToken, Task<WebArchiverService.PageProbe?>> Probe { get; set; }

    /// <summary>The oEmbed JSON fetch; tests replace it.</summary>
    internal Func<string, CancellationToken, Task<string?>> FetchJson { get; set; }

    public EmbedResolverService(IMemoryCache cache, ILogger<EmbedResolverService> logger)
    {
        _cache = cache;
        _logger = logger;
        Probe = (url, ct) => WebArchiverService.ProbeAsync(url, _logger, ct);
        FetchJson = (url, ct) => WebArchiverService.FetchJsonAsync(url, _logger, ct);
    }

    public async Task<EmbedResolution?> ResolveAsync(string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return null;
        var key = "embed:" + uri.AbsoluteUri;
        if (_cache.TryGetValue(key, out EmbedResolution? hit)) return hit;

        EmbedResolution? result = null;
        try
        {
            var probe = await Probe(uri.AbsoluteUri, ct);
            if (probe is not null)
            {
                var title = probe.Html is null ? null : LinkPreviewService.Parse(probe.FinalUri, probe.Html)?.Title;
                string? embedSrc = null;
                int? width = null, height = null;
                if (probe.Html is not null && FindOEmbedHref(probe.FinalUri, probe.Html) is { } oembed)
                {
                    var json = await FetchJson(oembed, ct);
                    if (json is not null && ParseOEmbed(json) is { } player)
                        (embedSrc, width, height, title) = (player.Src, player.Width, player.Height, player.Title ?? title);
                }
                result = new EmbedResolution(
                    uri.AbsoluteUri,
                    probe.FinalUri.AbsoluteUri,
                    AllowsFraming(probe.FrameOptions, probe.ContentSecurityPolicy),
                    embedSrc, width, height, title);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogDebug(ex, "Embed resolve failed for {Url}", uri);
        }
        if (result is not null) _cache.Set(key, result, Ttl);
        return result;
    }

    // ── Pure, unit-testable helpers ─────────────────────────────────────────────

    /// <summary>
    /// Whether a page may be shown in another site's frame. <c>X-Frame-Options</c>
    /// DENY/SAMEORIGIN forbids it; so does a CSP <c>frame-ancestors</c> that
    /// doesn't open up to any https site. (A site listing specific origins
    /// isn't listing this one.)
    /// </summary>
    internal static bool AllowsFraming(string? frameOptions, string? csp)
    {
        if (!string.IsNullOrWhiteSpace(frameOptions))
        {
            var xfo = frameOptions.Trim().ToLowerInvariant();
            if (xfo.Contains("deny") || xfo.Contains("sameorigin")) return false;
        }
        if (string.IsNullOrWhiteSpace(csp)) return true;
        foreach (var directive in csp.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = directive.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || !parts[0].Equals("frame-ancestors", StringComparison.OrdinalIgnoreCase)) continue;
            var sources = parts.Skip(1).Select(s => s.ToLowerInvariant()).ToArray();
            if (!sources.Any(s => s is "*" or "https:" or "http:" or "https://*")) return false;
        }
        return true;
    }

    [GeneratedRegex(@"<link\s[^>]*type\s*=\s*[""']application/json\+oembed[""'][^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex OEmbedLink();
    [GeneratedRegex(@"href\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex Href();
    [GeneratedRegex(@"<iframe\s[^>]*src\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex IframeSrc();

    /// <summary>The page's oEmbed endpoint (an https URL), when it advertises one.</summary>
    internal static string? FindOEmbedHref(Uri page, string html)
    {
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var head = headEnd > 0 ? html[..headEnd] : html[..Math.Min(html.Length, 200_000)];
        if (OEmbedLink().Match(head) is not { Success: true } link) return null;
        if (Href().Match(link.Value) is not { Success: true } href) return null;
        return Uri.TryCreate(page, WebUtility.HtmlDecode(href.Groups["v"].Value), out var abs) && abs.Scheme == Uri.UriSchemeHttps
            ? abs.AbsoluteUri
            : null;
    }

    internal sealed record OEmbedPlayer(string Src, int? Width, int? Height, string? Title);

    /// <summary>An oEmbed answer's player: the https <c>src</c> of the iframe in its <c>html</c>, with its size.</summary>
    internal static OEmbedPlayer? ParseOEmbed(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var html = root.TryGetProperty("html", out var h) && h.ValueKind == JsonValueKind.String ? h.GetString() : null;
            if (html is null || IframeSrc().Match(html) is not { Success: true } m) return null;
            var src = WebUtility.HtmlDecode(m.Groups["v"].Value);
            if (src.StartsWith("//", StringComparison.Ordinal)) src = "https:" + src;
            if (!Uri.TryCreate(src, UriKind.Absolute, out var srcUri) || srcUri.Scheme != Uri.UriSchemeHttps) return null;
            int? Num(string name) =>
                root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n is > 0 and <= 4000
                    ? n : null;
            var title = root.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            return new OEmbedPlayer(srcUri.AbsoluteUri, Num("width"), Num("height"), title);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
