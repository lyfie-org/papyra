using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// Recognises the conflict-copy files sync tools drop next to a note when two
// devices edited it offline. Syncthing writes `note.sync-conflict-<date>-<id>.md`;
// Dropbox/Nextcloud/ownCloud write `note (conflicted copy <date>).md`. Both land in
// the watched vault as plain `.md`, so without this guard the observer would parse
// them as real notes (and collide on the parent's id). We surface them as conflicts
// to resolve instead, mapped back to the parent file they shadow.
public static partial class ConflictDetector
{
    [GeneratedRegex(
        @"^(?<stem>.+?)\.sync-conflict-\d{8}-\d{6}-[0-9A-Za-z]+(?<ext>\.[^.]+)$",
        RegexOptions.Compiled)]
    private static partial Regex Syncthing();

    [GeneratedRegex(
        @"^(?<stem>.+?) \(.*conflicted copy.*\)(?<ext>\.[^.]+)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase)]
    private static partial Regex Conflicted();

    // True when a file name is a sync tool's conflict copy.
    public static bool IsConflict(string fileName) =>
        Syncthing().IsMatch(fileName) || Conflicted().IsMatch(fileName);

    // The parent note's file name this conflict shadows, or null if not a conflict.
    public static string? ParentFileName(string fileName)
    {
        var m = Syncthing().Match(fileName);
        if (!m.Success) m = Conflicted().Match(fileName);
        return m.Success ? m.Groups["stem"].Value + m.Groups["ext"].Value : null;
    }

    // Map a conflict's vault-relative path to its parent's vault-relative path,
    // keeping any sub-directory the pair share.
    public static string ParentRelativePath(string conflictRelativePath)
    {
        var dir = Path.GetDirectoryName(conflictRelativePath);
        var parentName = ParentFileName(Path.GetFileName(conflictRelativePath))
                         ?? Path.GetFileName(conflictRelativePath);
        return string.IsNullOrEmpty(dir) ? parentName : Path.Combine(dir, parentName);
    }

    // A stable, route-safe opaque id for a conflict (base64url of its relative
    // path). Only used as a dictionary key + URL segment; never decoded back.
    public static string EncodeId(string relativePath) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(relativePath.Replace('\\', '/')))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
