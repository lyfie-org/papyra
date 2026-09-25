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

        // CRLF (a file edited elsewhere) → LF, so Multiline `$` lands at line end.
        var text = markdown.Replace("\r\n", "\n").Replace('\r', '\n');
        // Escaped characters (\*) are literal, never markup: park them in stand-ins
        // the patterns below don't match, and put them back at the end.
        text = Escape().Replace(text, m => ((char)(EscapeBase + m.Groups[1].Value[0])).ToString());
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

        // The editor writes text that would read as syntax ("1. " typed as
        // words) as character references, and an empty line in a paragraph as
        // &#8203; — decoded only now, after the markup is gone.
        text = Reference().Replace(text, DecodeReference).Replace("​", string.Empty);
        text = RestoreEscapes(text);

        // Collapse the whitespace the stripping left behind, but keep single line
        // breaks so a multi-line note still reads as separate lines.
        text = IntraLineSpace().Replace(text, " ");
        text = LineEdgeSpace().Replace(text, "\n"); // a stripped trailing anchor leaves its space
        text = BlankRun().Replace(text, "\n");
        return text.Trim();
    }

    private const int EscapeBase = 0xF800;

    private static string RestoreEscapes(string text)
    {
        if (!text.Any(c => c >= EscapeBase && c < EscapeBase + 0x80)) return text;
        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
            if (chars[i] >= EscapeBase && chars[i] < EscapeBase + 0x80) chars[i] = (char)(chars[i] - EscapeBase);
        return new string(chars);
    }

    private static string DecodeReference(Match m)
    {
        var ok = m.Groups[1].Success
            ? int.TryParse(m.Groups[1].Value, out var code)
            : int.TryParse(m.Groups[2].Value, System.Globalization.NumberStyles.HexNumber, null, out code);
        return ok && code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF)
            ? char.ConvertFromUtf32(code)
            : m.Value;
    }

    // CommonMark backslash escape: `\` before any ASCII punctuation.
    [GeneratedRegex(@"\\([!-/:-@\[-`{-~])")]
    private static partial Regex Escape();

    [GeneratedRegex(@"&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));")]
    private static partial Regex Reference();

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

    // Block markers. A marker may end the line (an empty item/heading, or one
    // whose trailing space an editor trimmed), and list markers may be indented
    // any depth (luthor nests by 4 spaces), so neither leaves a stray "3." behind.
    [GeneratedRegex(@"^[ \t]{0,3}#{1,6}(?:[ \t]+|$)", RegexOptions.Multiline)]
    private static partial Regex Heading();

    [GeneratedRegex(@"^[ \t]{0,3}>[ \t]?", RegexOptions.Multiline)]
    private static partial Regex Quote();

    [GeneratedRegex(@"^[ \t]*[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)", RegexOptions.Multiline)]
    private static partial Regex TaskMarker();

    [GeneratedRegex(@"^[ \t]*[-*+](?:[ \t]+|$)", RegexOptions.Multiline)]
    private static partial Regex BulletMarker();

    [GeneratedRegex(@"^[ \t]*\d+\.(?:[ \t]+|$)", RegexOptions.Multiline)]
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

    [GeneratedRegex(@"[ \t]*\n[ \t]*")]
    private static partial Regex LineEdgeSpace();

    [GeneratedRegex(@"\n[ \t]*\n[\s]*")]
    private static partial Regex BlankRun();
}
