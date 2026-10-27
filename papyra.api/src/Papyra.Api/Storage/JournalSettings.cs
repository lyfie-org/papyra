using System.Text.Json;

namespace Papyra.Api.Storage;

/// <summary>One person's journal preferences. UI state, so they live under <c>.papyra/</c>, never the notes dir.</summary>
public sealed record JournalPrefs
{
    /// <summary>Hours past midnight at which a new journal day begins (0–5): a night owl's 01:30 is still "today".</summary>
    public int DayStartsAt { get; init; }
    /// <summary>New entries are created locked (needs a vault PIN).</summary>
    public bool LockNewEntries { get; init; }
    /// <summary>Show a gentle rotating prompt as the empty page's placeholder.</summary>
    public bool PromptsOn { get; init; } = true;
    /// <summary>Hide the streak everywhere (default off — the streak shows).</summary>
    public bool HideStreak { get; init; }
    /// <summary>Daily reminder email (off by default); local time "HH:mm".</summary>
    public bool ReminderOn { get; init; }
    public string? ReminderTime { get; init; }
    /// <summary>Last local date a reminder was sent, so a restart doesn't send it twice.</summary>
    public string? ReminderSentFor { get; init; }
    /// <summary>The template new days start from, by file name (null = a blank page).</summary>
    public string? DefaultTemplate { get; init; }
}

/// <summary>
/// Per-user journal preferences at <c>users/{uid}/.papyra/journal.json</c>.
/// Disposable like the other UI-state files: a missing or garbage file reads as
/// the defaults. Writes are atomic (tmp → replace). Registered as a singleton.
/// </summary>
public sealed class JournalSettings(IConfiguration config, IHostEnvironment env)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    public static string FileFor(IConfiguration config, string contentRoot, string userId) =>
        Path.Combine(PapyraPaths.UserDotPapyra(config, contentRoot, userId), "journal.json");

    public JournalPrefs Read(string userId)
    {
        var path = FileFor(config, env.ContentRootPath, userId);
        if (!File.Exists(path)) return new JournalPrefs();
        try
        {
            return Clean(JsonSerializer.Deserialize<JournalPrefs>(File.ReadAllText(path), Json) ?? new JournalPrefs());
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return new JournalPrefs();
        }
    }

    public JournalPrefs Write(string userId, JournalPrefs prefs)
    {
        prefs = Clean(prefs);
        var path = FileFor(config, env.ContentRootPath, userId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = Path.Combine(Path.GetDirectoryName(path)!, $"{Guid.NewGuid():N}.tmp");
        File.WriteAllText(tmp, JsonSerializer.Serialize(prefs, Json));
        if (File.Exists(path)) File.Replace(tmp, path, destinationBackupFileName: null);
        else File.Move(tmp, path, overwrite: true);
        return prefs;
    }

    private static JournalPrefs Clean(JournalPrefs p) => p with
    {
        DayStartsAt = Math.Clamp(p.DayStartsAt, 0, JournalClock.MaxDayStartsAt),
        ReminderTime = TimeOnly.TryParseExact(p.ReminderTime, "HH:mm", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var t) ? t.ToString("HH:mm") : null,
        DefaultTemplate = string.IsNullOrWhiteSpace(p.DefaultTemplate) ? null : Path.GetFileName(p.DefaultTemplate.Trim()),
    };
}
