using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class LinkPreviewTests
{
    [Fact]
    public void Parse_PrefersOpenGraph_AndMakesUrlsAbsolute()
    {
        const string html = """
            <html><head>
              <title>Fallback title</title>
              <meta property="og:title" content="Chai, properly &amp; slowly">
              <meta content="How to make it." name="description">
              <meta property="og:image" content="/img/chai.jpg">
              <meta property="og:site_name" content="Tea Notes">
              <link rel="shortcut icon" href="/favicon.png">
            </head><body>…</body></html>
            """;
        var p = LinkPreviewService.Parse(new Uri("https://tea.example.com/chai"), html)!;
        Assert.Equal("Chai, properly & slowly", p.Title);
        Assert.Equal("How to make it.", p.Description);
        Assert.Equal("https://tea.example.com/img/chai.jpg", p.Image);
        Assert.Equal("Tea Notes", p.SiteName);
        Assert.Equal("https://tea.example.com/favicon.png", p.Icon);
    }

    [Fact]
    public void Parse_FallsBackToTheTitleTag_AndDropsInsecureImages()
    {
        const string html = "<head><title>  Plain   page </title><meta property=\"og:image\" content=\"http://x.test/a.png\"></head>";
        var p = LinkPreviewService.Parse(new Uri("https://www.site.test/"), html)!;
        Assert.Equal("Plain page", p.Title);
        Assert.Null(p.Image); // the app only loads https images
        Assert.Equal("site.test", p.SiteName);
    }

    [Fact]
    public void Parse_NothingToShow_IsNull()
    {
        Assert.Null(LinkPreviewService.Parse(new Uri("https://x.test/"), "<html><body>hi</body></html>"));
    }
}
