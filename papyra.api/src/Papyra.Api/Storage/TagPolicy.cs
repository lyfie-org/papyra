namespace Papyra.Api.Storage;

/// <summary>
/// Limits on a note's tags. A tag is a label, not a sentence, and a note with
/// dozens of them stops being filterable in any useful way — so there is a cap on
/// both, enforced here and mirrored in the web client.
/// </summary>
public static class TagPolicy
{
    public const int MaxTagsPerNote = 20;
    public const int MaxTagLength = 40;

    /// <summary>
    /// Trim, drop empties, and de-duplicate case-insensitively (first spelling wins).
    /// </summary>
    public static List<string> Normalize(IEnumerable<string>? tags)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in tags ?? [])
        {
            var tag = raw?.Trim();
            if (string.IsNullOrEmpty(tag) || !seen.Add(tag)) continue;
            result.Add(tag);
        }
        return result;
    }

    /// <summary>
    /// Why this tag set is refused, or null. <paramref name="priorCount"/> is how many
    /// tags the note had before: a note that arrived with more than the cap (an
    /// import, a file edited outside Papyra) can still be saved and trimmed — only
    /// adding past the cap is refused, never keeping what is already there.
    /// </summary>
    public static string? Validate(IReadOnlyCollection<string> tags, int priorCount)
    {
        if (tags.Count > MaxTagsPerNote && tags.Count > priorCount)
            return $"A note can have at most {MaxTagsPerNote} tags.";
        var tooLong = tags.FirstOrDefault(t => t.Length > MaxTagLength);
        return tooLong is null ? null : $"A tag can be at most {MaxTagLength} characters.";
    }
}
