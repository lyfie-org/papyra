using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// Reads the `^id` block anchors Luthor stamps onto a note body, so one block can
// be served without exposing the note around it (Phase 15 transclusion).
//
// The editor appends ` ^id` to the last line of an eligible block — paragraphs,
// headings and quotes only; lists, tables and code blocks are never stamped,
// because an inline anchor there would corrupt the structure. Ids are 8 chars of
// [a-z0-9] as generated, but the markdown transformer accepts the wider
// `[A-Za-z0-9][A-Za-z0-9_-]*`, so that is what we parse.
public static partial class BlockResolver
{
    // An anchor token anywhere in the line. It is normally the trailing suffix,
    // but the anchor is an invisible node in the editor and the caret can be
    // placed after it, so typing at the end of a block leaves it mid-line
    // ("First paragraph. ^a1b2c3d4 More words."). Matching only at end-of-line
    // silently broke every reference to such a block, so position is ignored and
    // the token is stripped out of the returned text instead.
    [GeneratedRegex(@"(?<=^|[ \t])\^(?<id>[A-Za-z0-9][A-Za-z0-9_-]*)(?=[ \t]|$)")]
    private static partial Regex AnchorToken();

    // Fence open/close for ``` and ~~~ blocks (with optional info string).
    [GeneratedRegex(@"^\s{0,3}(?<fence>`{3,}|~{3,})")]
    private static partial Regex Fence();

    public readonly record struct Anchor(string BlockId, string Text, int Line);

    /// <summary>Every anchor in the body, in document order.</summary>
    public static IReadOnlyList<Anchor> Anchors(string? body)
    {
        var found = new List<Anchor>();
        if (string.IsNullOrEmpty(body)) return found;

        var lines = body.Replace("\r\n", "\n").Split('\n');
        string? openFence = null;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];

            // A ` ^id` sequence inside a fenced code block is literal source, not
            // an anchor — the editor never stamps there, so neither do we read it.
            var fence = Fence().Match(line);
            if (fence.Success)
            {
                var marker = fence.Groups["fence"].Value;
                if (openFence is null) openFence = marker;
                else if (marker[0] == openFence[0] && marker.Length >= openFence.Length) openFence = null;
                continue;
            }
            if (openFence is not null) continue;

            var m = AnchorToken().Match(line);
            if (!m.Success) continue;

            // Strip every anchor token from the line, not only the matched one, so
            // a block that somehow carries two never leaks a stray "^id" into the
            // text a reader sees.
            var text = AnchorToken().Replace(line, string.Empty);
            text = CollapseGaps().Replace(text, " ").Trim();
            if (text.Length == 0) continue; // a bare "^id" line anchors nothing
            found.Add(new Anchor(m.Groups["id"].Value, text, i));
        }

        return found;
    }

    /// <summary>
    /// The text of one anchored block, without its anchor suffix. Null when the
    /// body carries no such anchor. Duplicate ids resolve to the first match,
    /// mirroring the editor's own first-wins de-duplication.
    /// </summary>
    public static string? Resolve(string? body, string? blockId)
    {
        if (string.IsNullOrWhiteSpace(blockId)) return null;
        foreach (var anchor in Anchors(body))
            if (string.Equals(anchor.BlockId, blockId, StringComparison.Ordinal))
                return anchor.Text;
        return null;
    }

    /// <summary>
    /// Guards a block id coming off the wire before it is used in a lookup or
    /// echoed back — same spirit as PathGuard.IsValidNoteId, though a block id
    /// never touches the filesystem.
    /// </summary>
    public static bool IsValidBlockId(string? blockId)
        => !string.IsNullOrEmpty(blockId)
           && blockId.Length <= 64
           && BlockId().IsMatch(blockId);

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]*$")]
    private static partial Regex BlockId();

    // Removing a mid-line anchor leaves a double space behind.
    [GeneratedRegex(@"[ 	]{2,}")]
    private static partial Regex CollapseGaps();
}
