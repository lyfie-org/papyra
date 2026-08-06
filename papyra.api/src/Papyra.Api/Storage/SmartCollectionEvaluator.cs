using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// One rule: match a note field against a value. Fields: tag, color, pinned, kind, text.
public sealed record SmartRule(string? Field, string? Value);

// A rule set: Match is "all" (AND) or "any" (OR) over the conditions.
public sealed record SmartRules(string? Match, List<SmartRule>? Conditions);

// Evaluates smart-collection rules against a note. Pure + unit-testable. Membership is
// computed live over the vault, so notes are never moved out of the main feed.
public static class SmartCollectionEvaluator
{
    public static bool Matches(Note note, SmartRules rules)
    {
        var conditions = rules.Conditions;
        if (conditions is null || conditions.Count == 0) return false;

        bool One(SmartRule c)
        {
            var value = c.Value ?? string.Empty;
            return (c.Field ?? string.Empty).ToLowerInvariant() switch
            {
                "tag" or "tags" => note.Tags.Any(t => string.Equals(t, value, StringComparison.OrdinalIgnoreCase)),
                "color" => string.Equals(note.Color ?? string.Empty, value, StringComparison.OrdinalIgnoreCase),
                "pinned" => note.Pinned == value.Equals("true", StringComparison.OrdinalIgnoreCase),
                "kind" => string.Equals(note.Kind, value, StringComparison.OrdinalIgnoreCase),
                "text" => (note.Title ?? string.Empty).Contains(value, StringComparison.OrdinalIgnoreCase)
                          || (note.Body ?? string.Empty).Contains(value, StringComparison.OrdinalIgnoreCase),
                _ => false,
            };
        }

        return string.Equals(rules.Match, "any", StringComparison.OrdinalIgnoreCase)
            ? conditions.Any(One)
            : conditions.All(One);
    }
}
