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
}
