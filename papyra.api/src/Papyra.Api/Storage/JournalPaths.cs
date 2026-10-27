using System.Globalization;

namespace Papyra.Api.Storage;

/// <summary>
/// Where a journal entry lives and what it is called. The path is a function of
/// the date alone — <c>journal/2026/10/2026-10-25.md</c> under the notes dir —
/// never of the title, so renaming logic can't touch it and a person browsing
/// the folder (or syncing it to Obsidian) sees dated files. Dates are parsed
/// strictly: anything but <c>yyyy-MM-dd</c> is refused before it reaches a path.
/// </summary>
public static class JournalPaths
{
    public const string Kind = "journal";
    public const string Folder = "journal";
    public const string IdPrefix = "journal-";

    /// <summary>Strict ISO date: exactly <c>yyyy-MM-dd</c>, a real calendar day, year 1900+.</summary>
    public static bool TryParseDate(string? text, out DateOnly day)
    {
        day = default;
        if (text is null || text.Length != 10) return false;
        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out day)) return false;
        return day.Year >= 1900;
    }

    public static string IdFor(DateOnly day) => IdPrefix + JournalClock.Format(day);

    /// <summary>The date a journal id names, if it names one.</summary>
    public static bool TryDateFromId(string? id, out DateOnly day)
    {
        day = default;
        return id is not null && id.StartsWith(IdPrefix, StringComparison.Ordinal) && TryParseDate(id[IdPrefix.Length..], out day);
    }

    public static bool IsJournalId(string? id) => TryDateFromId(id, out _);

    private static readonly System.Text.RegularExpressions.Regex EntryId = new(@"journal-\d{4}-\d{2}-\d{2}", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>True when a request path or query names a journal entry id anywhere in it.</summary>
    public static bool NamesAnEntry(string? pathAndQuery) => pathAndQuery is not null && EntryId.IsMatch(pathAndQuery);

    public static bool IsJournal(Models.Note note) =>
        string.Equals(note.Kind, Kind, StringComparison.OrdinalIgnoreCase);

    /// <summary>The entry's file under <paramref name="notesDir"/>.</summary>
    public static string PathFor(string notesDir, DateOnly day) =>
        Path.Combine(notesDir, Folder,
            day.Year.ToString("D4", CultureInfo.InvariantCulture),
            day.Month.ToString("D2", CultureInfo.InvariantCulture),
            JournalClock.Format(day) + ".md");
}
