using Papyra.Api.Storage;

namespace Papyra.Tests;

// Search snippets are prose shown to a person. These pin the block-marker
// stripping against the shapes the editor actually writes: nested items (4-space
// indent), empty items (`3. `, or `3.` once trailing whitespace was trimmed), an
// anchor left on an emptied item, and CRLF files edited outside Papyra. Mirrors
// flattenMarkdown's tests in the web app (plainText.test.ts).
public sealed class PlainTextTests
{
    [Fact]
    public void Flatten_StripsNestedAndEmptyListMarkers()
    {
        var md = string.Join('\n',
            "1. Whiskey ^w1",
            "    1. Yamazaki ^y1",
            "    2. Hibiki",
            "    3. ^0b9vdhib",
            "    4.",
            "- [ ]",
            "#");
        Assert.Equal("Whiskey\nYamazaki\nHibiki", PlainText.Flatten(md));
    }

    [Fact]
    public void Flatten_TreatsCrlfLikeLf()
    {
        Assert.Equal("A\nB", PlainText.Flatten("1. A\r\n    2.\r\n- [x]\r\n# \r\nB"));
    }

    [Fact]
    public void Flatten_LeavesNumbersAndHashtagsInProseAlone()
    {
        Assert.Equal("1.5 kg rice #tag", PlainText.Flatten("1.5 kg rice #tag"));
    }

    // The editor writes text that would read as syntax as character references
    // and escapes; a snippet shows what the person typed.
    [Theory]
    [InlineData("&#35; not a heading", "# not a heading")]
    [InlineData("1&#46; not a list", "1. not a list")]
    [InlineData("see &#91;x](y)", "see [x](y)")]
    [InlineData(@"a \*not italic\* b", "a *not italic* b")]
    [InlineData(@"snake\_case\_name", "snake_case_name")]
    [InlineData("&#38;#35; literally", "&#35; literally")]
    [InlineData("one\n&#8203;\nthree", "one\nthree")]
    [InlineData("a\n\n\n\nb", "a\nb")]
    [InlineData("&amp; &#0; &#xZZ;", "&amp; &#0; &#xZZ;")]
    [InlineData(@"C:\path\to", @"C:\path\to")]
    public void Flatten_ResolvesEscapesAndReferences(string md, string expected)
    {
        Assert.Equal(expected, PlainText.Flatten(md));
    }
}
