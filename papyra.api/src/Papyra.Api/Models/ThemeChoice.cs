using System.Text.RegularExpressions;

namespace Papyra.Api.Models;

/// <summary>
/// The theme an account keeps: <c>light</c>, <c>dark</c>, <c>system</c>, or a
/// daily schedule <c>schedule:HH:MM-HH:MM</c> — light from the first time, dark
/// from the second (either order, so light can just as well run overnight). The
/// browser applies it by its own clock; the server only checks the shape.
/// Mirrors papyra.web lib/themeSchedule.
/// </summary>
public static partial class ThemeChoice
{
    [GeneratedRegex(@"^schedule:([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$")]
    private static partial Regex Schedule();

    public const string Problem = "Theme is light, dark, system or a schedule (schedule:07:00-19:00).";

    public static bool IsValid(string? theme)
    {
        if (theme is "light" or "dark" or "system") return true;
        if (theme is null) return false;
        var m = Schedule().Match(theme);
        // Light and dark need different start times, or one of them never shows.
        return m.Success && (m.Groups[1].Value, m.Groups[2].Value) != (m.Groups[3].Value, m.Groups[4].Value);
    }
}
