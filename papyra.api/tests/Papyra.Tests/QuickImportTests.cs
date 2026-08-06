using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class QuickImportTests
{
    [Fact]
    public void Sanitize_StripsScriptBlocks_EventHandlers_AndJsUris()
    {
        const string input = "# Title\n\n<script>alert(1)</script>Normal **text**.\n" +
                             "<img src=x onerror=\"steal()\">\n[bad](javascript:alert(2))";
        var clean = QuickImport.Sanitize(input);

        Assert.DoesNotContain("<script", clean);
        Assert.DoesNotContain("alert(1)", clean);   // block content removed
        Assert.DoesNotContain("onerror", clean);
        Assert.DoesNotContain("javascript:", clean);
        Assert.Contains("Normal **text**.", clean);  // markdown preserved
    }

    [Fact]
    public void TitleFrom_PrefersFirstHeading()
    {
        Assert.Equal("My Heading", QuickImport.TitleFrom("\n\n# My Heading\n\nbody", "notes.md"));
    }

    [Fact]
    public void TitleFrom_FallsBackToFilenameStem_WhenNoLeadingHeading()
    {
        Assert.Equal("grocery-list", QuickImport.TitleFrom("just some text\n# later heading", "grocery-list.txt"));
    }
}
