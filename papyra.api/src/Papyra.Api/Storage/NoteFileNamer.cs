using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// Human file names for notes: <c>weekly-groceries.md</c>, not a GUID.
///
/// The approach Obsidian, Bear and Joplin's exporters share: a note's identity
/// is the stable <c>id</c> in its YAML front matter; its file name is only a
/// readable label, derived from the note and kept in step with it.
/// <list type="bullet">
/// <item>From the title, else from the body's first line — a title outranks
///   content. A note with too little to name (one stray letter) keeps its
///   random id-based name until it has some.</item>
/// <item>A slug: lower-case letters and digits (any script) joined by hyphens,
///   at most 60 characters, never a name Windows reserves — safe on every file
///   system, in a URL and in git.</item>
/// <item>Collisions get <c>-2</c>, <c>-3</c>… A file already at
///   <c>name-2.md</c> for the name it wants is left alone, so two notes with the
///   same title don't trade names back and forth on every save.</item>
/// <item>A rename is one atomic <see cref="File.Move(string,string)"/> in the
///   note's own folder, marked in the <see cref="WriteRing"/> so the watcher
///   doesn't mistake it for a delete and a new note. Links, history and shares
///   all key on the id, so none of them notice.</item>
/// </list>
/// </summary>
public static partial class NoteFileNamer
{
    private const int MaxLength = 60;
    // Below this, content is too thin to name a file after (a first keystroke).
    private const int MinContentLength = 3;

    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    };

    [GeneratedRegex(@"-\d+$")]
    private static partial Regex CollisionSuffix();

    [GeneratedRegex(@"^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*")]
    private static partial Regex LinePrefix();

    [GeneratedRegex(@"!?\[\[([^\]|#]*)(?:[^\]]*)\]\]|!?\[([^\]]*)\]\([^)]*\)|[*_`~^]|\s\^[\w-]+\s*$")]
    private static partial Regex InlineMarkup();

    /// <summary>The name a note should have (no extension), or null when it has nothing to be named after yet.</summary>
    public static string? DesiredBaseName(Note note)
    {
        var fromTitle = Slug(note.Title);
        if (fromTitle.Length > 0) return fromTitle;

        var line = FirstContentLine(note.Body);
        var fromBody = Slug(line);
        return fromBody.Length >= MinContentLength ? fromBody : null;
    }

    /// <summary>Lower-case letters and digits of any script, hyphen-joined, capped, never reserved.</summary>
    public static string Slug(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;
        var decomposed = text.Normalize(NormalizationForm.FormKD);
        var sb = new StringBuilder(decomposed.Length);
        var pendingHyphen = false;
        foreach (var c in decomposed)
        {
            var cat = CharUnicodeInfo.GetUnicodeCategory(c);
            if (cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark)
                continue; // é → e; the accent is not part of the name
            if (char.IsLetterOrDigit(c))
            {
                if (pendingHyphen && sb.Length > 0) sb.Append('-');
                pendingHyphen = false;
                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                pendingHyphen = true;
            }
        }
        var slug = sb.ToString();
        if (slug.Length > MaxLength)
        {
            slug = slug[..MaxLength];
            // Cut at a word boundary when there is one reasonably close.
            var cut = slug.LastIndexOf('-');
            if (cut > MaxLength / 2) slug = slug[..cut];
            slug = slug.TrimEnd('-');
        }
        if (Reserved.Contains(slug)) slug += "-note";
        return slug;
    }

    // The first line that says something, stripped of markdown syntax.
    private static string FirstContentLine(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return string.Empty;
        foreach (var raw in body.Split('\n'))
        {
            var line = LinePrefix().Replace(raw, string.Empty);
            line = InlineMarkup().Replace(line, m => m.Groups[1].Success ? m.Groups[1].Value
                : m.Groups[2].Success ? m.Groups[2].Value : " ");
            if (line.Trim().Length > 0)
            {
                // A name, not a paragraph: the first several words.
                var words = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                return string.Join(' ', words.Take(8));
            }
        }
        return string.Empty;
    }

    /// <summary>
    /// Where a note should live: <paramref name="currentPath"/> itself when its
    /// name already fits (or there is nothing better to call it), else a free
    /// path in the same folder.
    /// </summary>
    public static string TargetPath(string currentPath, string? desiredBase, string noteId)
    {
        if (desiredBase is null) return currentPath;
        var stem = Path.GetFileNameWithoutExtension(currentPath);
        if (Fits(stem, desiredBase)) return currentPath;
        // A name a person chose ("My Recipes.md" from Obsidian, or typed in a
        // file manager) is theirs: other apps may link to it by that name. Only
        // names Papyra made — an id, or one of its own slugs — follow the note.
        if (!IsPapyraName(stem, noteId)) return currentPath;
        return FreePath(Path.GetDirectoryName(currentPath)!, desiredBase, currentPath);
    }

    /// <summary>The path for a brand-new note in <paramref name="dir"/>.</summary>
    public static string NewPath(string dir, string? desiredBase, string id)
    {
        // Nothing to name it after yet: its id (random) until there is.
        var name = desiredBase ?? (Slug(id) is { Length: > 0 } fromId ? fromId : "untitled");
        return FreePath(dir, name, except: null);
    }

    /// <summary>An id (the note's own, or GUID-shaped) or already in slug form.</summary>
    public static bool IsPapyraName(string stem, string noteId) =>
        string.Equals(stem, noteId, StringComparison.OrdinalIgnoreCase)
        || Guid.TryParse(stem, out _)
        || (stem.Length > 0 && string.Equals(stem, Slug(stem), StringComparison.Ordinal));

    // "groceries" fits "groceries" and "groceries-3" (a collision suffix it was given).
    private static bool Fits(string stem, string desiredBase) =>
        string.Equals(stem, desiredBase, StringComparison.OrdinalIgnoreCase)
        || (stem.StartsWith(desiredBase + "-", StringComparison.OrdinalIgnoreCase)
            && CollisionSuffix().IsMatch(stem[desiredBase.Length..]));

    private static string FreePath(string dir, string baseName, string? except)
    {
        for (var n = 1; ; n++)
        {
            var candidate = Path.Combine(dir, n == 1 ? $"{baseName}.md" : $"{baseName}-{n}.md");
            // Case-insensitive on purpose: macOS and Windows file systems are.
            if (except is not null && string.Equals(Path.GetFullPath(candidate), Path.GetFullPath(except), StringComparison.OrdinalIgnoreCase))
                return except;
            if (!File.Exists(candidate)) return candidate;
        }
    }

    /// <summary>
    /// Rename <paramref name="currentPath"/> to <paramref name="targetPath"/>
    /// atomically, keeping the watcher and the in-memory vault in step. Returns
    /// the path the note now lives at (the old one if the move couldn't happen).
    /// </summary>
    public static string Move(string userId, string currentPath, string targetPath, VaultState state, WriteRing writeRing, ILogger logger)
    {
        if (string.Equals(currentPath, targetPath, StringComparison.Ordinal)) return currentPath;
        try
        {
            writeRing.Mark(currentPath);
            writeRing.Mark(targetPath);
            // Same-folder case-only renames (Groceries → groceries) need the
            // two-step on case-insensitive file systems.
            if (string.Equals(currentPath, targetPath, StringComparison.OrdinalIgnoreCase))
            {
                var hop = currentPath + ".rename-" + Guid.NewGuid().ToString("N")[..8];
                File.Move(currentPath, hop);
                File.Move(hop, targetPath);
            }
            else
            {
                File.Move(currentPath, targetPath, overwrite: false);
            }
            if (state.TryGet(userId, currentPath, out var note) && note is not null)
            {
                state.Remove(userId, currentPath);
                state.Upsert(userId, targetPath, note);
            }
            return targetPath;
        }
        catch (IOException ex)
        {
            // Taken in the meantime, or locked by another program: keep the old
            // name; the next save tries again.
            logger.LogWarning(ex, "Could not rename {From} to {To}", currentPath, targetPath);
            return currentPath;
        }
    }
}
