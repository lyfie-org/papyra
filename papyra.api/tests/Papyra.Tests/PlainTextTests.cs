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
}
