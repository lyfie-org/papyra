using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

public sealed record JournalTemplate(string Name, string Body);

/// <summary>
/// The pages a day can start from: plain markdown files at
/// <c>users/{uid}/.papyra/journal-templates/{name}.md</c> with <c>{{date}}</c>,
/// <c>{{weekday}}</c> and <c>{{streak}}</c> filled in by the page. Outside the notes
/// dir on purpose — a template there would be adopted as a note. Writes are atomic.
/// </summary>
public sealed partial class JournalTemplates(IConfiguration config, IHostEnvironment env)
{
    public const int MaxTemplates = 20;
    public const int MaxBytes = 20_000;
    public const int MaxName = 60;
    public const string Folder = "journal-templates";

    // Letters, digits, spaces and a few marks: a name that is also a safe file name on every OS.
    [GeneratedRegex(@"^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,59}$")]
    private static partial Regex Valid();

    public static string DirFor(IConfiguration config, string contentRoot, string userId) =>
        Path.Combine(PapyraPaths.UserDotPapyra(config, contentRoot, userId), Folder);

    // Windows keeps these for devices, whatever the extension.
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
        { "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
          "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9" };

    /// <summary>The name as it will be stored, or null when it can't be one.</summary>
    public static string? Clean(string? name)
    {
        var n = (name ?? string.Empty).Trim();
        if (n.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) n = n[..^3].TrimEnd();
        if (n.Length > MaxName || !Valid().IsMatch(n) || n.EndsWith('.')) return null;
        return Reserved.Contains(n.Split('.')[0].Trim()) ? null : n;
    }

    private string PathFor(string uid, string name) => Path.Combine(DirFor(config, env.ContentRootPath, uid), name + ".md");

    public IReadOnlyList<JournalTemplate> List(string uid)
    {
        var dir = DirFor(config, env.ContentRootPath, uid);
        if (!Directory.Exists(dir)) return [];
        var list = new List<JournalTemplate>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.md").OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase).Take(MaxTemplates))
        {
            var name = Clean(Path.GetFileNameWithoutExtension(file));
            if (name is null) continue; // a file dropped in by hand with a name we won't serve
            try { list.Add(new JournalTemplate(name, File.ReadAllText(file))); }
            catch (IOException) { /* in the middle of being replaced: skip this once */ }
        }
        return list;
    }

    public enum SaveStatus { Ok, BadName, TooLarge, TooMany }

    public SaveStatus Save(string uid, string? name, string? body, out string? stored)
    {
        stored = Clean(name);
        if (stored is null) return SaveStatus.BadName;
        body ??= string.Empty;
        if (System.Text.Encoding.UTF8.GetByteCount(body) > MaxBytes) return SaveStatus.TooLarge;

        var path = PathFor(uid, stored);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);
        if (!File.Exists(path) && Directory.EnumerateFiles(dir, "*.md").Count() >= MaxTemplates) return SaveStatus.TooMany;

        var tmp = Path.Combine(dir, $"{Guid.NewGuid():N}.tmp");
        File.WriteAllText(tmp, body);
        if (File.Exists(path)) File.Replace(tmp, path, destinationBackupFileName: null);
        else File.Move(tmp, path, overwrite: true);
        return SaveStatus.Ok;
    }

    public bool Delete(string uid, string? name)
    {
        var clean = Clean(name);
        if (clean is null) return false;
        var path = PathFor(uid, clean);
        if (!File.Exists(path)) return false;
        File.Delete(path);
        return true;
    }
}
