namespace Papyra.Api.Storage;

// The note colour palette, mirrored from papyra.web/src/lib/noteColors.ts — keep
// the two in step. A note's YAML `color:` is free text; these are the swatches the
// picker offers. Values from the previous palette still sit in notes on disk, so
// they alias to the swatch that replaced them (Moss folded into Sage) wherever a
// colour is compared — smart collections, for one.
public static class NotePalette
{
    public const string Sage = "#d3e8d0";
    public const string Sand = "#f1e4c7";
    public const string Clay = "#f8d6c4";
    public const string Rose = "#fbd3d9";
    public const string Lilac = "#e0d9f5";
    public const string Sky = "#c1e5f7";

    private static readonly Dictionary<string, string> Canonical = new(StringComparer.OrdinalIgnoreCase)
    {
        [Sage] = Sage,
        [Sand] = Sand,
        [Clay] = Clay,
        [Rose] = Rose,
        [Lilac] = Lilac,
        [Sky] = Sky,
        // Previous palette.
        ["#dfe9df"] = Sage,
        ["#dde7d4"] = Sage, // Moss
        ["#ece3cf"] = Sand,
        ["#ecdcd0"] = Clay,
        ["#ecd9da"] = Rose,
        ["#e2dcec"] = Lilac,
        ["#d8e3ea"] = Sky,
    };

    /// <summary>The current swatch a colour belongs to, or the colour itself (trimmed) when it is not a palette colour.</summary>
    public static string Normalize(string? colour)
    {
        var c = (colour ?? string.Empty).Trim();
        return Canonical.TryGetValue(c, out var swatch) ? swatch : c;
    }

    /// <summary>Whether two colours are the same swatch — legacy values included — or the same text.</summary>
    public static bool Same(string? a, string? b) =>
        string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase);
}
