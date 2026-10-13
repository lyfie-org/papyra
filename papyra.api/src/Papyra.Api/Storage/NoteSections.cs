using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>One step of a section patch (see <see cref="NoteSections"/>).</summary>
public sealed record SectionOp(string? Op, string? Heading, int? Level, int? Occurrence, string? Content);

public sealed record SectionPatch(SectionOp[]? Ops);

/// <summary>A heading in a note's outline.</summary>
public sealed record SectionHeading(string Heading, int Level, int Occurrence);

/// <summary>
/// Edit a note by its headings instead of rewriting the whole body — what a
/// script or agent wants ("replace Day 3", "append to Packing list"). A section
/// is a heading line and everything below it up to the next heading of the
/// same or a higher level. Headings inside fenced code are not headings.
/// Ops apply in order, each to the result of the one before:
/// <list type="bullet">
///   <item><c>replace</c> — everything under the heading, subsections included
///   (the heading line stays);</item>
///   <item><c>append</c> / <c>prepend</c> — to the end of the section's own text
///   (before any subsection) / right under its heading, or to the end / start of
///   the whole note when no heading is given;</item>
///   <item><c>insertAfter</c> / <c>insertBefore</c> — beside the whole section
///   (for adding a new section, content usually starts with its own heading);</item>
///   <item><c>delete</c> — the section, heading and all.</item>
/// </list>
/// Headings match ignoring case, surrounding <c>#</c>s, extra spaces and a
/// trailing block anchor (<c>^id</c>); <c>level</c> narrows the match and
/// <c>occurrence</c> (1-based) picks one of several equal headings.
/// </summary>
public static partial class NoteSections
{
    public const int MaxOps = 50;

    private static readonly string[] Known = ["replace", "append", "prepend", "insertAfter", "insertBefore", "delete"];

    [GeneratedRegex(@"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")]
    private static partial Regex AtxHeading();

    [GeneratedRegex(@"^\s{0,3}(`{3,}|~{3,})")]
    private static partial Regex Fence();

    [GeneratedRegex(@"[ \t]+#+$")]
    private static partial Regex ClosingHashes();

    [GeneratedRegex(@"\s+\^[A-Za-z0-9_-]+$")]
    private static partial Regex BlockAnchor();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    private sealed record Heading(int Line, int Level, string Text);

    /// <summary>The note's headings, in order.</summary>
    public static IReadOnlyList<SectionHeading> Outline(string body)
    {
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        return Headings(Lines(body)).Select(h =>
        {
            var key = $"{h.Level}|{Normalize(h.Text)}";
            seen[key] = seen.GetValueOrDefault(key) + 1;
            return new SectionHeading(h.Text, h.Level, seen[key]);
        }).ToList();
    }

    /// <summary>Apply <paramref name="ops"/> to <paramref name="body"/>: the new body, or why not.</summary>
    public static (string? Body, string? Error) Apply(string body, IReadOnlyList<SectionOp> ops)
    {
        if (ops.Count == 0) return (null, "Send at least one op.");
        if (ops.Count > MaxOps) return (null, $"Send at most {MaxOps} ops at a time.");
        var newline = body.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var lines = Lines(body);

        for (var i = 0; i < ops.Count; i++)
        {
            var op = ops[i];
            var name = Known.FirstOrDefault(k => string.Equals(k, op.Op?.Trim(), StringComparison.OrdinalIgnoreCase));
            var where = $"Op {i + 1}";
            if (name is null) return (null, $"{where}: \"op\" must be one of {string.Join(", ", Known)}.");
            var content = Lines(op.Content ?? string.Empty);
            TrimBlankEdges(content);
            if (name != "delete" && content.Count == 0) return (null, $"{where}: \"content\" is required.");

            if (string.IsNullOrWhiteSpace(op.Heading))
            {
                if (name == "append") Splice(lines, EndOfContent(lines, lines.Count), content);
                else if (name == "prepend") Splice(lines, 0, content);
                else return (null, $"{where}: \"{name}\" needs a \"heading\".");
                continue;
            }

            var (section, error) = Find(lines, op);
            if (error is not null) return (null, $"{where}: {error}");
            var (start, ownEnd, end) = section!.Value;
            var contentEnd = EndOfContent(lines, end, floor: start + 1);
            switch (name)
            {
                case "replace":
                    lines.RemoveRange(start + 1, contentEnd - start - 1);
                    Splice(lines, start + 1, content);
                    break;
                case "append":
                    // After the section's own text, before any subsection.
                    Splice(lines, EndOfContent(lines, ownEnd, floor: start + 1), content);
                    break;
                case "prepend":
                    Splice(lines, start + 1, content);
                    break;
                case "insertAfter":
                    Splice(lines, contentEnd, content);
                    break;
                case "insertBefore":
                    Splice(lines, start, content);
                    break;
                case "delete":
                    lines.RemoveRange(start, contentEnd - start);
                    // Don't leave a double gap (or a dangling one at the end) where it was.
                    if (start > 0 && IsBlank(lines[start - 1]) && (start == lines.Count || IsBlank(lines[start])))
                        lines.RemoveAt(start - 1);
                    break;
            }
        }
        return (string.Join(newline, lines), null);
    }

    private static List<string> Lines(string text) =>
        [.. text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n')];

    private static bool IsBlank(string line) => line.Trim().Length == 0;

    private static void TrimBlankEdges(List<string> lines)
    {
        while (lines.Count > 0 && IsBlank(lines[0])) lines.RemoveAt(0);
        while (lines.Count > 0 && IsBlank(lines[^1])) lines.RemoveAt(lines.Count - 1);
    }

    private static string Normalize(string text) => Spaces().Replace(text.Trim(), " ").ToLowerInvariant();

    private static IEnumerable<Heading> Headings(List<string> lines)
    {
        string? fence = null;
        for (var i = 0; i < lines.Count; i++)
        {
            var marker = Fence().Match(lines[i]);
            if (fence is not null)
            {
                if (marker.Success && marker.Groups[1].Value[0] == fence[0] && marker.Groups[1].Value.Length >= fence.Length)
                    fence = null;
                continue;
            }
            if (marker.Success)
            {
                fence = marker.Groups[1].Value;
                continue;
            }
            var heading = AtxHeading().Match(lines[i]);
            if (!heading.Success) continue;
            var text = BlockAnchor().Replace(ClosingHashes().Replace(heading.Groups[2].Value, ""), "").Trim();
            yield return new Heading(i, heading.Groups[1].Value.Length, text);
        }
    }

    /// <summary>
    /// The section an op names: its heading line, where its own text ends (the
    /// first subheading), and where it ends (the next same-or-higher heading).
    /// </summary>
    private static ((int Start, int OwnEnd, int End)? Section, string? Error) Find(List<string> lines, SectionOp op)
    {
        var wanted = op.Heading!.Trim();
        var level = op.Level;
        // "## Day 3" means level 2 unless a level was given.
        var hashes = wanted.TakeWhile(c => c == '#').Count();
        if (hashes is > 0 and <= 6 && (wanted.Length == hashes || char.IsWhiteSpace(wanted[hashes])))
        {
            level ??= hashes;
            wanted = wanted[hashes..];
        }
        var key = Normalize(BlockAnchor().Replace(wanted, ""));

        var all = Headings(lines).ToList();
        var matches = all.Where(h => Normalize(h.Text) == key && (level is null || h.Level == level)).ToList();
        if (matches.Count == 0)
        {
            var known = all.Count == 0 ? "the note has no headings" : "headings: " + string.Join(", ", all.Select(h => $"\"{h.Text}\""));
            return (null, $"no heading \"{op.Heading!.Trim()}\" ({known}).");
        }
        Heading pick;
        if (op.Occurrence is { } n)
        {
            if (n < 1 || n > matches.Count) return (null, $"\"occurrence\" must be 1–{matches.Count} for \"{op.Heading!.Trim()}\".");
            pick = matches[n - 1];
        }
        else if (matches.Count > 1)
            return (null, $"{matches.Count} headings match \"{op.Heading!.Trim()}\"; add \"level\" or \"occurrence\".");
        else pick = matches[0];

        var end = all.FirstOrDefault(h => h.Line > pick.Line && h.Level <= pick.Level)?.Line ?? lines.Count;
        var ownEnd = all.FirstOrDefault(h => h.Line > pick.Line)?.Line ?? lines.Count;
        return ((pick.Line, Math.Min(ownEnd, end), end), null);
    }

    /// <summary>Where content ending at <paramref name="end"/> really ends: before its trailing blank lines.</summary>
    private static int EndOfContent(List<string> lines, int end, int floor = 0)
    {
        while (end > floor && IsBlank(lines[end - 1])) end--;
        return end;
    }

    /// <summary>Insert <paramref name="content"/> at <paramref name="at"/> as its own block(s), blank-line separated.</summary>
    private static void Splice(List<string> lines, int at, List<string> content)
    {
        var block = new List<string>(content);
        if (at > 0 && !IsBlank(lines[at - 1])) block.Insert(0, string.Empty);
        if (at < lines.Count && !IsBlank(lines[at])) block.Add(string.Empty);
        // An empty note is one blank line: fill it instead of padding around it.
        if (lines.Count == 1 && IsBlank(lines[0]))
        {
            lines.Clear();
            lines.AddRange(content);
            return;
        }
        lines.InsertRange(at, block);
    }
}
