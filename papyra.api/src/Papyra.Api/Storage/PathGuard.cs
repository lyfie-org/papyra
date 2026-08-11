using System.Security;

namespace Papyra.Api.Storage;

// Chroot enforcement for the per-tenant vault. Every filename that reaches disk —
// a note id from the route, a media filename — is resolved against the user's base
// dir and must stay inside it. A crafted name like `../../1/notes/secret.md`
// resolves outside the fence and is rejected with a SecurityException (→ 403),
// never read or written. The breach attempt is logged.
public static class PathGuard
{
    // Resolve `requestedName` under `userBaseDir` and verify it cannot escape.
    // Returns the verified absolute path; throws SecurityException on a breach.
    public static string ResolveAndVerify(string userBaseDir, string requestedName, ILogger? logger = null)
    {
        var baseFull = Path.GetFullPath(userBaseDir);
        var combined = Path.GetFullPath(Path.Combine(baseFull, requestedName));

        // Fence with a trailing separator so a sibling dir sharing a prefix
        // (users/1 vs users/10) can't sneak past a naive StartsWith.
        var fence = baseFull.EndsWith(Path.DirectorySeparatorChar)
            ? baseFull
            : baseFull + Path.DirectorySeparatorChar;

        if (!combined.StartsWith(fence, StringComparison.Ordinal))
        {
            logger?.LogWarning(
                "Path-jail breach blocked: base {Base}, requested {Requested}",
                baseFull, requestedName);
            throw new SecurityException($"Path '{requestedName}' escapes the user vault.");
        }

        return combined;
    }

    // A note id becomes a filename, so it has to be a *name* — not a path, not a
    // Windows device, not something with control characters in it. PathGuard
    // already stops an id from escaping the vault, but without this a request
    // could still litter the vault with unusable names like
    // `..%2F..%2Fetc%2Fpasswd.md` (URL-decoded to a literal filename), which the
    // API then can't address again to delete.
    public static bool IsValidNoteId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return false;
        if (id.Length > 128) return false;
        if (id is "." or "..") return false;
        if (id.Contains("..", StringComparison.Ordinal)) return false;
        if (id.Contains('/') || id.Contains('\\')) return false;
        // %2F / %5C survive as literals when a client double-encodes them.
        if (id.Contains('%')) return false;
        if (id.Contains(':')) return false; // NTFS alternate data streams
        foreach (var c in id)
        {
            if (char.IsControl(c)) return false;
            if (Path.GetInvalidFileNameChars().Contains(c)) return false;
        }
        // Reserved DOS device names (CON, PRN, AUX, NUL, COM1..9, LPT1..9).
        var stem = id.Split('.')[0].ToUpperInvariant();
        if (stem is "CON" or "PRN" or "AUX" or "NUL") return false;
        if (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal))
            && char.IsDigit(stem[3]) && stem[3] != '0') return false;
        return true;
    }
}
