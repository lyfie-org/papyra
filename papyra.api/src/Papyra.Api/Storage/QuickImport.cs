using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// Helpers for dashboard quick-import (drag a .md/.txt onto the grid → a new note).
// Pure + unit-testable; the endpoint wires them to the atomic write path.
public static partial class QuickImport
{
    [GeneratedRegex(@"<(script|style|iframe|object|embed)\b[^>]*>.*?</\1\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ActiveBlocks();

    [GeneratedRegex(@"\son[a-z]+\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex EventHandlers();

    [GeneratedRegex(@"javascript:", RegexOptions.IgnoreCase)]
    private static partial Regex JavascriptUri();

    [GeneratedRegex(@"^#{1,6}\s+(.+)$")]
    private static partial Regex HeadingLine();

    // Neutralize active content in imported text while keeping the Markdown intact:
    // drop <script>/<style>/<iframe>/<object>/<embed> blocks, inline on* handlers,
    // and javascript: URIs. (The renderer is the last line of defense; this stops
    // dangerous content at rest on import.)
    public static string Sanitize(string input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;
        var s = ActiveBlocks().Replace(input, string.Empty);
        s = EventHandlers().Replace(s, string.Empty);
        s = JavascriptUri().Replace(s, string.Empty);
        return s.Trim();
    }

    // Title from the first Markdown heading; otherwise the filename stem.
    public static string TitleFrom(string body, string filename)
    {
        foreach (var raw in body.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            var m = HeadingLine().Match(line);
            return m.Success ? m.Groups[1].Value.Trim() : FromFilename(filename);
        }
        return FromFilename(filename);
    }

    private static string FromFilename(string filename)
    {
        var stem = Path.GetFileNameWithoutExtension(filename);
        return string.IsNullOrWhiteSpace(stem) ? "Imported note" : stem.Trim();
    }
}
