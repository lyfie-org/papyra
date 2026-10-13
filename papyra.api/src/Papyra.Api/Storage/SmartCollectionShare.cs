using System.Text.Json;

namespace Papyra.Api.Storage;

// A smart collection as it travels between people: copied as JSON, pasted into
// another account, or sent in-app as a collection_offer. Only the name and the
// rules go — never notes: the rules run against whatever vault receives them.
//
//   { "papyraCollection": 1, "name": "Trips", "rules": { "match": "all", "conditions": [ … ] } }
//
// Pasted JSON comes from anywhere, so Read rebuilds the rules from known parts
// rather than storing what arrived.
public static class SmartCollectionShare
{
    public const int Version = 1;
    public const int MaxNameLength = 120;
    public const int MaxConditions = 50;
    public const int MaxValueLength = 500;

    private static readonly HashSet<string> Fields = new(StringComparer.OrdinalIgnoreCase)
        { "tag", "color", "pinned", "kind", "text" };

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    /// <summary>The shareable form of a saved collection.</summary>
    public static string Write(string name, string rulesJson)
    {
        using var rules = JsonDocument.Parse(rulesJson);
        return JsonSerializer.Serialize(new { papyraCollection = Version, name, rules = rules.RootElement }, Web);
    }

    /// <summary>
    /// Reads pasted or offered JSON into a name and clean rules JSON, or says
    /// (in words a person can act on) why it can't be used.
    /// </summary>
    public static bool TryRead(string? json, out string name, out string rulesJson, out string error)
    {
        name = rulesJson = error = string.Empty;
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(json ?? string.Empty);
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            error = "That isn’t a Papyra collection — the text isn’t valid JSON.";
            return false;
        }

        if (root.ValueKind != JsonValueKind.Object
            || !TryGet(root, "papyraCollection", out var version) || version.ValueKind != JsonValueKind.Number)
        {
            error = "That isn’t a Papyra collection.";
            return false;
        }
        if (!version.TryGetInt32(out var v) || v != Version)
        {
            error = "That collection comes from a newer Papyra. Update this one to bring it in.";
            return false;
        }

        name = TryGet(root, "name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()!.Trim() : string.Empty;
        if (name.Length == 0) { error = "The collection needs a name."; return false; }
        if (name.Length > MaxNameLength) name = name[..MaxNameLength].TrimEnd();

        if (!TryGet(root, "rules", out var rules) || rules.ValueKind != JsonValueKind.Object
            || !TryGet(rules, "conditions", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            error = "The collection has no rules.";
            return false;
        }

        var match = TryGet(rules, "match", out var m) && m.ValueKind == JsonValueKind.String
            && string.Equals(m.GetString(), "any", StringComparison.OrdinalIgnoreCase) ? "any" : "all";

        var conditions = new List<SmartRule>();
        foreach (var c in list.EnumerateArray())
        {
            if (c.ValueKind != JsonValueKind.Object
                || !TryGet(c, "field", out var f) || f.ValueKind != JsonValueKind.String || !Fields.Contains(f.GetString()!)
                || !TryGet(c, "value", out var val) || val.ValueKind != JsonValueKind.String)
            {
                error = "One of the collection’s rules isn’t one Papyra knows.";
                return false;
            }
            var value = val.GetString()!;
            if (value.Length > MaxValueLength) { error = "One of the collection’s rules is too long."; return false; }
            conditions.Add(new SmartRule(f.GetString()!.ToLowerInvariant(), value));
        }
        if (conditions.Count == 0) { error = "The collection has no rules."; return false; }
        if (conditions.Count > MaxConditions) { error = $"A collection can have at most {MaxConditions} rules."; return false; }

        rulesJson = JsonSerializer.Serialize(new SmartRules(match, conditions), Web);
        return true;
    }

    /// <summary>"Trips", or "Trips (2)", "Trips (3)"… when the name is taken.</summary>
    public static string UniqueName(string name, IEnumerable<string> taken)
    {
        var used = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        if (!used.Contains(name)) return name;
        for (var i = 2; ; i++)
        {
            var candidate = $"{name} ({i})";
            if (!used.Contains(candidate)) return candidate;
        }
    }

    // Property names compared without case: hand-edited JSON is often PascalCase.
    private static bool TryGet(JsonElement obj, string name, out JsonElement value)
    {
        foreach (var p in obj.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) { value = p.Value; return true; }
        value = default;
        return false;
    }
}
