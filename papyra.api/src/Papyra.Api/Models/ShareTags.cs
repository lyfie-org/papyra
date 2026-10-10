using System.Text.Json;
using System.Text.RegularExpressions;

namespace Papyra.Api.Models;

/// <summary>
/// A grantee's own tags for a note shared with them (<see cref="Share.GranteeTags"/>):
/// stored as a JSON array, trimmed, de-duplicated without regard to case, and
/// bounded so a client can't grow a share row without limit.
/// </summary>
public static class ShareTags
{
    public const int MaxTags = 30;
    public const int MaxLength = 64;

    public static IReadOnlyList<string> Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<List<string>>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>The clean list, or null when it breaks the bounds.</summary>
    public static List<string>? Normalize(IEnumerable<string>? tags)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in tags ?? [])
        {
            var tag = raw?.Trim() ?? string.Empty;
            if (tag.Length == 0) continue;
            if (tag.Length > MaxLength) return null;
            if (seen.Add(tag)) result.Add(tag);
        }
        return result.Count > MaxTags ? null : result;
    }
}

/// <summary>A note colour as written to front matter: a hex colour or a palette name.</summary>
public static partial class NoteColorValue
{
    [GeneratedRegex(@"^(#[0-9a-fA-F]{3,8}|[a-z][a-z0-9-]{0,31})$")]
    private static partial Regex Pattern();

    public static bool IsValid(string value) => Pattern().IsMatch(value);
}
