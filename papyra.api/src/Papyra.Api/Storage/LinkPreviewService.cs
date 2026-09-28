using System.Net;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace Papyra.Api.Storage;

/// <summary>What a link looks like as a card: title, description, picture, site.</summary>
public sealed record LinkPreview(string Url, string Title, string? Description, string? Image, string SiteName, string? Icon);

/// <summary>
/// Link cards for notes, the way Keep shows a pasted link: the page's own title,
/// summary and picture (Open Graph / Twitter tags, falling back to &lt;title&gt;
/// and the meta description).
///
/// Fetched by the server, never the browser, through the same SSRF-guarded
/// client as the web archiver — public addresses only, redirects re-checked,
/// size capped — so a note can't be used to probe the LAN. Results (and misses)
/// are cached for a day, so a desk full of links costs one fetch each.
/// </summary>
public sealed partial class LinkPreviewService
{
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(24);
    private static readonly TimeSpan MissTtl = TimeSpan.FromHours(1);

    private readonly IMemoryCache _cache;
    private readonly ILogger<LinkPreviewService> _logger;

    public LinkPreviewService(IMemoryCache cache, ILogger<LinkPreviewService> logger)
    {
        _cache = cache;
        _logger = logger;
    }

    public async Task<LinkPreview?> GetAsync(string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return null;
        var key = "linkpreview:" + uri.AbsoluteUri;
        if (_cache.TryGetValue(key, out LinkPreview? hit)) return hit;

        LinkPreview? preview = null;
        try
        {
            var html = await WebArchiverService.FetchHtmlAsync(uri.AbsoluteUri, _logger, ct);
            if (html is not null) preview = Parse(uri, html);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogDebug(ex, "Link preview failed for {Url}", uri);
        }
        _cache.Set(key, preview, preview is null ? MissTtl : Ttl);
        return preview;
    }

    [GeneratedRegex(@"<meta\s[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex MetaTag();
    [GeneratedRegex(@"(?<name>property|name|content|itemprop)\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex Attr();
    [GeneratedRegex(@"<title[^>]*>(?<t>[\s\S]*?)</title>", RegexOptions.IgnoreCase)]
    private static partial Regex TitleTag();
    [GeneratedRegex(@"<link\s[^>]*rel\s*=\s*[""'][^""']*icon[^""']*[""'][^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex IconTag();
    [GeneratedRegex(@"href\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex Href();
    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    internal static LinkPreview? Parse(Uri page, string html)
    {
        // Only the head matters, and a huge body shouldn't be scanned.
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var head = headEnd > 0 ? html[..headEnd] : html[..Math.Min(html.Length, 200_000)];

        var meta = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match tag in MetaTag().Matches(head))
        {
            string? name = null, content = null;
            foreach (Match a in Attr().Matches(tag.Value))
            {
                var attr = a.Groups["name"].Value.ToLowerInvariant();
                if (attr == "content") content = a.Groups["v"].Value;
                else name ??= a.Groups["v"].Value;
            }
            if (name is not null && content is not null && !meta.ContainsKey(name)) meta[name] = Clean(content);
        }

        string? Pick(params string[] keys) =>
            keys.Select(k => meta.GetValueOrDefault(k)).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

        var title = Pick("og:title", "twitter:title")
            ?? (TitleTag().Match(head) is { Success: true } t ? Clean(t.Groups["t"].Value) : null);
        if (string.IsNullOrWhiteSpace(title)) return null;

        var description = Pick("og:description", "twitter:description", "description");
        var image = Absolute(page, Pick("og:image", "og:image:url", "twitter:image", "twitter:image:src"));
        var site = Pick("og:site_name", "application-name") ?? page.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase);
        var icon = IconTag().Match(head) is { Success: true } i && Href().Match(i.Value) is { Success: true } h
            ? Absolute(page, WebUtility.HtmlDecode(h.Groups["v"].Value))
            : new Uri(page, "/favicon.ico").AbsoluteUri;

        return new LinkPreview(
            page.AbsoluteUri,
            Truncate(title, 140),
            description is null ? null : Truncate(description, 280),
            // The app's CSP allows https images only.
            image is not null && image.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? image : null,
            Truncate(site, 60),
            icon is not null && icon.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? icon : null);
    }

    private static string? Absolute(Uri page, string? href)
    {
        if (string.IsNullOrWhiteSpace(href)) return null;
        return Uri.TryCreate(page, href.Trim(), out var abs) && (abs.Scheme == Uri.UriSchemeHttps || abs.Scheme == Uri.UriSchemeHttp)
            ? abs.AbsoluteUri : null;
    }

    private static string Clean(string s) => Spaces().Replace(WebUtility.HtmlDecode(s), " ").Trim();

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..(max - 1)].TrimEnd() + "…";
}
