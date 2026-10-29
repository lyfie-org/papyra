using System.Text;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>How the journal book sets what a day holds.</summary>
public sealed class JournalPdfTests
{
    private static string Pdf(string body)
    {
        using var ms = new MemoryStream();
        JournalPdf.Write(ms, [new BookDay(new DateOnly(2026, 10, 27), 4, body)], "Journal", "Someone", _ => null);
        return Encoding.Latin1.GetString(ms.ToArray());
    }

    [Fact]
    public void ALineIndentedByATabOrFourSpaces_IsAParagraph_NotACodeBlock()
    {
        // The editor's indent writes leading spaces; to Markdown that is "code", which printed in a monospace face.
        Assert.DoesNotContain("RobotoMono", Pdf("    I wish I could pull developers in to talk about other things.\n\n\tOh also, the developer."));
    }

    [Fact]
    public void CodeThatIsFenced_IsStillSetInTheMonospaceFace()
    {
        Assert.Contains("RobotoMono", Pdf("```\nconst a = 1;\n```"));
        Assert.Contains("RobotoMono", Pdf("a `snippet` inline"));
    }
}
