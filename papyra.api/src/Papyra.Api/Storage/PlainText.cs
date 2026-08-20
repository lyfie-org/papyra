using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>
/// Flattens a note's markdown into the prose a human would read.
///
/// Search snippets used to be highlighted straight out of the raw body, so they
/// showed the editor's bookkeeping to the user: block anchors like
/// <c>^p5fozaot</c> appeared mid-sentence as meaningless strings, along with
/// heading hashes and link syntax. A snippet is prose shown to a person, so
/// anything that only means something to the parser is stripped first.
///
/// Mirrors <c>stripMarkdown</c> in the web app (NoteCard.tsx) — the two must stay
/// in step, or a note reads differently in a card than in a search result.
/// </summary>
public static partial class PlainText
{
    /// <summary>Markdown in, readable prose out. Never throws; worst case returns the input.</summary>
    public static string Flatten(string? markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return string.Empty;

        var text = markdown;
        text = FencedCode().Replace(text, " ");
        text = InlineCode().Replace(text, "$1");
        text = MediaEmbed().Replace(text, " ");
        text = BlockAnchor().Replace(text, string.Empty);
        text = WikiLink().Replace(text, "$1");
        text = Image().Replace(text, " ");
        text = Link().Replace(text, "$1");
        text = Heading().Replace(text, string.Empty);
        text = Quote().Replace(text, string.Empty);
        text = TaskMarker().Replace(text, string.Empty);
        text = BulletMarker().Replace(text, string.Empty);
        text = OrderedMarker().Replace(text, string.Empty);
        text = HorizontalRule().Replace(text, " ");
        text = Bold().Replace(text, "$2");
        text = Italic().Replace(text, "$2");
        text = Strikethrough().Replace(text, "$1");

        // Collapse the whitespace the stripping left behind, but keep single line
        // breaks so a multi-line note still reads as separate lines.
        text = IntraLineSpace().Replace(text, " ");
        text = BlankRun().Replace(text, "\n");
        return text.Trim();
    }

    // Luthor stamps every block with a trailing `^id` so transclusion can address
    // it. Purely machine-facing — never shown.
    [GeneratedRegex(@"(?<=^|[ \t])\^[A-Za-z0-9][A-Za-z0-9_-]*(?=[ \t]|$)", RegexOptions.Multiline)]
    private static partial Regex BlockAnchor();

    [GeneratedRegex(@"```[\s\S]*?```")]
    private static partial Regex FencedCode();

    [GeneratedRegex(@"`([^`]+)`")]
    private static partial Regex InlineCode();

    [GeneratedRegex(@"!\[\[[^\]]*\]\]")]
    private static partial Regex MediaEmbed();

    [GeneratedRegex(@"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")]
    private static partial Regex WikiLink();

    [GeneratedRegex(@"!\[[^\]]*\]\([^)]*\)")]
    private static partial Regex Image();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]*\)")]
    private static partial Regex Link();

    [GeneratedRegex(@"^[ ]{0,3}#{1,6}[ ]+", RegexOptions.Multiline)]
    private static partial Regex Heading();

    [GeneratedRegex(@"^[ ]{0,3}>[ ]?", RegexOptions.Multiline)]
    private static partial Regex Quote();

    [GeneratedRegex(@"^[ ]{0,3}[-*+][ ]+\[[ xX]\][ ]+", RegexOptions.Multiline)]
    private static partial Regex TaskMarker();

    [GeneratedRegex(@"^[ ]{0,3}[-*+][ ]+", RegexOptions.Multiline)]
    private static partial Regex BulletMarker();

    [GeneratedRegex(@"^[ ]{0,3}\d+\.[ ]+", RegexOptions.Multiline)]
    private static partial Regex OrderedMarker();

    [GeneratedRegex(@"^[ ]{0,3}(?:[-*_][ ]*){3,}$", RegexOptions.Multiline)]
    private static partial Regex HorizontalRule();

    [GeneratedRegex(@"(\*\*|__)(.*?)\1")]
    private static partial Regex Bold();

    [GeneratedRegex(@"(\*|_)(.*?)\1")]
    private static partial Regex Italic();

    [GeneratedRegex(@"~~(.*?)~~")]
    private static partial Regex Strikethrough();

    [GeneratedRegex(@"[ \t]+")]
    private static partial Regex IntraLineSpace();

    [GeneratedRegex(@"\n[ \t]*\n[\s]*")]
    private static partial Regex BlankRun();
}
