using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>One item of a to-do list: its place among the list's items, its text, whether it's ticked.</summary>
public sealed record ChecklistItem(int Index, string Text, bool Checked);

/// <summary>
/// Reads and ticks the checklist items of a note's markdown (<c>- [ ] text</c>,
/// <c>- [x] text</c>; <c>-</c>, <c>*</c> or <c>+</c>, any nesting). Fenced code is
/// skipped. A to-do embedded in a journal day is addressed as
/// <c>![[Title#^checklist]]</c>: the whole list, by a reserved block id that the
/// editor never generates (its anchors are eight characters), so it can't
/// collide with a real anchor. An item is named by its <c>Index</c> *and* its text,
/// so a list that changed since it was drawn is noticed, never mis-ticked.
/// </summary>
public static partial class Checklist
{
    /// <summary>The block id that means "this note's checklist".</summary>
    public const string BlockId = "checklist";

    [GeneratedRegex(@"^(?<lead>[ \t]*[-*+][ \t]+\[)(?<mark>[ xX])(?<tail>\][ \t]+)(?<text>\S.*?)[ \t]*$")]
    private static partial Regex ItemLine();

    [GeneratedRegex(@"^\s{0,3}(`{3,}|~{3,})")]
    private static partial Regex Fence();

    private static IEnumerable<(int Line, Match Match)> Matches(string[] lines)
    {
        string? open = null;
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].TrimEnd('\r');
            var fence = Fence().Match(line);
            if (fence.Success)
            {
                var marker = fence.Groups[1].Value;
                if (open is null) open = marker;
                else if (marker[0] == open[0] && marker.Length >= open.Length) open = null;
                continue;
            }
            if (open is not null) continue;
            var m = ItemLine().Match(line);
            if (m.Success) yield return (i, m);
        }
    }

    public static IReadOnlyList<ChecklistItem> Parse(string? body)
    {
        if (string.IsNullOrEmpty(body)) return [];
        var lines = body.Replace("\r\n", "\n").Split('\n');
        return Matches(lines)
            .Select((x, n) => new ChecklistItem(n, ClearAnchor(x.Match.Groups["text"].Value), x.Match.Groups["mark"].Value != " "))
            .ToList();
    }

    /// <summary>The list as the editor would draw it, for resolving the embed: just its item lines.</summary>
    public static string Render(string? body) =>
        string.Join('\n', Parse(body).Select(i => $"- [{(i.Checked ? 'x' : ' ')}] {i.Text}"));

    // A trailing ` ^id` block anchor is the editor's, not the person's text.
    private static string ClearAnchor(string text) => BlockResolver.Clean(text);

    public enum TickStatus { Changed, Unchanged, Stale }

    /// <summary>
    /// Set item <paramref name="index"/> (which must still read <paramref name="text"/>) to
    /// <paramref name="isChecked"/>. When the list moved on — the item at that index now reads
    /// differently — the item is found by its text if exactly one matches; otherwise <c>Stale</c>.
    /// </summary>
    public static (TickStatus Status, string Body) Set(string body, int index, string text, bool isChecked)
    {
        var newline = body.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var lines = body.Replace("\r\n", "\n").Split('\n');
        var found = Matches(lines).ToList();
        var wanted = text.Trim();

        int? at = null;
        if (index >= 0 && index < found.Count && ClearAnchor(found[index].Match.Groups["text"].Value) == wanted) at = index;
        else
        {
            var same = found.Select((x, n) => (x, n)).Where(p => ClearAnchor(p.x.Match.Groups["text"].Value) == wanted).ToList();
            if (same.Count == 1) at = same[0].n;
        }
        if (at is null) return (TickStatus.Stale, body);

        var (line, m) = found[at.Value];
        var already = m.Groups["mark"].Value != " ";
        if (already == isChecked) return (TickStatus.Unchanged, body);
        var raw = lines[line];
        var cr = raw.EndsWith('\r') ? "\r" : string.Empty;
        // Swap only the mark: everything else on the line (indent, bullet, text, anchor) stays as written.
        lines[line] = m.Groups["lead"].Value + (isChecked ? "x" : " ") + raw.TrimEnd('\r')[(m.Groups["lead"].Length + 1)..] + cr;
        return (TickStatus.Changed, string.Join(newline, lines));
    }
}
