using System.Text.RegularExpressions;

namespace Papyra.Tests;

/// <summary>
/// A note's file on disk, found by the `id` in its front matter. Files are named
/// after the note's title (see NoteFileNamer), not its id, so tests look them up
/// the way Papyra does rather than guessing `{id}.md`.
/// </summary>
internal static class NoteFiles
{
    public static string? TryFind(string notesDir, string id)
    {
        if (!Directory.Exists(notesDir)) return null;
        var pattern = new Regex($@"(?m)^id:\s*['""]?{Regex.Escape(id)}['""]?\s*$");
        return Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).Contains(".sync-conflict", StringComparison.Ordinal))
            .FirstOrDefault(f => pattern.IsMatch(File.ReadAllText(f)));
    }

    public static string Find(string notesDir, string id) =>
        TryFind(notesDir, id) ?? throw new FileNotFoundException($"No note file with id '{id}' under {notesDir}");
}
