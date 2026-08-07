using System.Net;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class WebArchiverServiceTests
{
    [Fact]
    public void ExtractUrls_FindsHttpUrls_AndTrimsTrailingPunctuation()
    {
        const string body = "See https://example.com/article, and (http://foo.test/x). Not ftp://nope.test.";
        var urls = WebArchiverService.ExtractUrls(body).ToList();
        Assert.Equal(["https://example.com/article", "http://foo.test/x"], urls);
    }

    [Fact]
    public void ArchiveFileName_IsStablePerUrl_AndScoped()
    {
        var a = WebArchiverService.ArchiveFileName("https://example.com/a");
        Assert.Equal(a, WebArchiverService.ArchiveFileName("https://example.com/a")); // stable
        Assert.NotEqual(a, WebArchiverService.ArchiveFileName("https://example.com/b"));
        Assert.StartsWith("archived-", a);
        Assert.EndsWith(".md", a);
    }

    [Theory]
    [InlineData("127.0.0.1", false)]     // loopback
    [InlineData("10.0.0.5", false)]      // private
    [InlineData("172.16.9.9", false)]    // private
    [InlineData("192.168.1.1", false)]   // private
    [InlineData("169.254.169.254", false)] // link-local / cloud metadata
    [InlineData("100.64.0.1", false)]    // CGNAT
    [InlineData("224.0.0.1", false)]     // multicast
    [InlineData("0.0.0.0", false)]       // unspecified
    [InlineData("8.8.8.8", true)]        // public
    [InlineData("1.1.1.1", true)]        // public
    public void IsPubliclyRoutable_BlocksInternalRanges(string ip, bool expected)
    {
        Assert.Equal(expected, WebArchiverService.IsPubliclyRoutable(IPAddress.Parse(ip)));
    }

    [Theory]
    [InlineData("::1", false)]           // IPv6 loopback
    [InlineData("fe80::1", false)]       // link-local
    [InlineData("fc00::1", false)]       // unique-local
    [InlineData("2606:4700:4700::1111", true)] // public (Cloudflare)
    public void IsPubliclyRoutable_HandlesIPv6(string ip, bool expected)
    {
        Assert.Equal(expected, WebArchiverService.IsPubliclyRoutable(IPAddress.Parse(ip)));
    }
}
