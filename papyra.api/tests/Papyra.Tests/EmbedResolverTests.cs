using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class EmbedResolverTests
{
    [Theory]
    [InlineData(null, null, true)]
    [InlineData("DENY", null, false)]
    [InlineData("SAMEORIGIN", null, false)]
    [InlineData("ALLOWALL", null, true)]
    [InlineData(null, "default-src 'self'; frame-ancestors 'self'", false)]
    [InlineData(null, "frame-ancestors 'none'", false)]
    [InlineData(null, "frame-ancestors https://partner.example", false)]
    [InlineData(null, "frame-ancestors *", true)]
    [InlineData(null, "script-src 'self'; frame-ancestors https: 'self'", true)]
    [InlineData(null, "default-src 'self'", true)]
    public void AllowsFraming_ReadsXFrameOptionsAndFrameAncestors(string? xfo, string? csp, bool expected)
    {
        Assert.Equal(expected, EmbedResolverService.AllowsFraming(xfo, csp));
    }

    [Fact]
    public void FindOEmbedHref_FindsTheAdvertisedJsonEndpoint()
    {
        const string html = """
            <html><head>
              <link rel="alternate" type="application/json+oembed"
                    href="https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F1&amp;w=640" title="Clip">
            </head></html>
            """;
        Assert.Equal(
            "https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F1&w=640",
            EmbedResolverService.FindOEmbedHref(new Uri("https://vimeo.com/1"), html));
    }

    [Fact]
    public void FindOEmbedHref_IgnoresInsecureOrMissingEndpoints()
    {
        Assert.Null(EmbedResolverService.FindOEmbedHref(new Uri("https://x.test/"),
            "<head><link rel=\"alternate\" type=\"application/json+oembed\" href=\"http://x.test/o\"></head>"));
        Assert.Null(EmbedResolverService.FindOEmbedHref(new Uri("https://x.test/"), "<head><title>t</title></head>"));
    }

    [Fact]
    public void ParseOEmbed_TakesTheIframePlayer()
    {
        const string json = """
            {"type":"video","title":"A clip","width":640,"height":360,
             "html":"<iframe src=\"https://player.vimeo.com/video/1?h=abc&amp;app_id=1\" width=\"640\" height=\"360\"></iframe>"}
            """;
        var player = EmbedResolverService.ParseOEmbed(json)!;
        Assert.Equal("https://player.vimeo.com/video/1?h=abc&app_id=1", player.Src);
        Assert.Equal(640, player.Width);
        Assert.Equal(360, player.Height);
        Assert.Equal("A clip", player.Title);
    }

    [Theory]
    [InlineData("""{"html":"<blockquote>no frame</blockquote><script src=\"https://x.test/w.js\"></script>"}""")]
    [InlineData("""{"html":"<iframe src=\"http://insecure.test/p\"></iframe>"}""")]
    [InlineData("""{"html":"<iframe src=\"javascript:alert(1)\"></iframe>"}""")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void ParseOEmbed_RefusesAnythingButAnHttpsFrame(string json)
    {
        Assert.Null(EmbedResolverService.ParseOEmbed(json));
    }

    [Fact]
    public void ParseOEmbed_CompletesProtocolRelativeSources()
    {
        var player = EmbedResolverService.ParseOEmbed("""{"html":"<iframe src='//w.soundcloud.com/player/?url=x'></iframe>"}""");
        Assert.Equal("https://w.soundcloud.com/player/?url=x", player!.Src);
    }

    private static EmbedResolverService Service(
        Func<string, CancellationToken, Task<WebArchiverService.PageProbe?>> probe,
        Func<string, CancellationToken, Task<string?>>? json = null) =>
        new(new MemoryCache(new MemoryCacheOptions()), NullLogger<EmbedResolverService>.Instance)
        {
            Probe = probe,
            FetchJson = json ?? ((_, _) => Task.FromResult<string?>(null)),
        };

    [Fact]
    public async Task Resolve_FollowsAShortLinkToWhereItLands()
    {
        var service = Service((_, _) => Task.FromResult<WebArchiverService.PageProbe?>(new(
            new Uri("https://www.google.com/maps/place/Nikkawahama+Beach/@35.84,140.8,15z"),
            "SAMEORIGIN", null, "text/html", "<head><title>Nikkawahama Beach - Google Maps</title></head>")));
        var r = (await service.ResolveAsync("https://maps.app.goo.gl/abc", CancellationToken.None))!;
        Assert.Equal("https://maps.app.goo.gl/abc", r.Url);
        Assert.Equal("https://www.google.com/maps/place/Nikkawahama+Beach/@35.84,140.8,15z", r.FinalUrl);
        Assert.False(r.Frameable); // the browser embeds the Maps link through its own form
        Assert.Equal("Nikkawahama Beach - Google Maps", r.Title);
    }

    [Fact]
    public async Task Resolve_UsesThePagesOEmbedPlayer()
    {
        var service = Service(
            (_, _) => Task.FromResult<WebArchiverService.PageProbe?>(new(
                new Uri("https://media.example.com/watch/1"), null, null, "text/html",
                "<head><link rel='alternate' type='application/json+oembed' href='https://media.example.com/oembed?u=1'></head>")),
            (url, _) => Task.FromResult<string?>(url == "https://media.example.com/oembed?u=1"
                ? """{"title":"Talk","width":800,"height":450,"html":"<iframe src=\"https://media.example.com/player/1\"></iframe>"}"""
                : null));
        var r = (await service.ResolveAsync("https://media.example.com/watch/1", CancellationToken.None))!;
        Assert.Equal("https://media.example.com/player/1", r.EmbedSrc);
        Assert.Equal(800, r.Width);
        Assert.Equal(450, r.Height);
        Assert.Equal("Talk", r.Title);
    }

    [Fact]
    public async Task Resolve_ReportsAPageThatRefusesFraming()
    {
        var service = Service((_, _) => Task.FromResult<WebArchiverService.PageProbe?>(new(
            new Uri("https://news.example.com/a"), null, "frame-ancestors 'self'", "text/html", "<head><title>A</title></head>")));
        var r = (await service.ResolveAsync("https://news.example.com/a", CancellationToken.None))!;
        Assert.False(r.Frameable);
        Assert.Null(r.EmbedSrc);
    }

    [Fact]
    public async Task Resolve_UnreachableOrNonHttp_IsNull()
    {
        var service = Service((_, _) => Task.FromResult<WebArchiverService.PageProbe?>(null));
        Assert.Null(await service.ResolveAsync("https://down.example.com/", CancellationToken.None));
        Assert.Null(await service.ResolveAsync("file:///etc/passwd", CancellationToken.None));
        Assert.Null(await service.ResolveAsync("not a url", CancellationToken.None));
    }

    [Fact]
    public async Task Probe_RefusesPrivateAddresses()
    {
        // The real probe, no stub: loopback and metadata addresses never get fetched.
        Assert.Null(await WebArchiverService.ProbeAsync("http://127.0.0.1/", NullLogger.Instance, CancellationToken.None));
        Assert.Null(await WebArchiverService.ProbeAsync("http://169.254.169.254/latest/meta-data", NullLogger.Instance, CancellationToken.None));
        Assert.Null(await WebArchiverService.FetchJsonAsync("https://localhost/o", NullLogger.Instance, CancellationToken.None));
    }
}
