namespace Papyra.Api.Storage;

// Resolves the on-disk data root cross-platform. Container mounts a volume at
// /data; local dev falls back to <contentRoot>/data. Override via config
// "Papyra:DataDir" or env PAPYRA_DATA_DIR.
public static class PapyraPaths
{
    public static string DataDir(IConfiguration config, string contentRoot)
    {
        var configured = config["Papyra:DataDir"];
        var root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(contentRoot, "data")
            : configured;
        return Path.GetFullPath(root);
    }

    // Hidden dir for Papyra-owned state (DB, lucene index) — never the notes dir.
    public static string DotPapyra(IConfiguration config, string contentRoot)
        => Path.Combine(DataDir(config, contentRoot), ".papyra");

    // Per-tenant root. Each user's vault is chrooted under users/{userId}/ so a
    // path-jail breach in one tenant can never reach another's notes.
    public static string UsersDir(IConfiguration config, string contentRoot)
        => Path.Combine(DataDir(config, contentRoot), "users");

    // The user-facing notes vault: the .md files are the source of truth.
    public static string UserNotesDir(IConfiguration config, string contentRoot, string userId)
        => Path.Combine(UsersDir(config, contentRoot), userId, "notes");

    // Uploaded attachments referenced by a user's notes via ![[filename]].
    public static string UserMediaDir(IConfiguration config, string contentRoot, string userId)
        => Path.Combine(UsersDir(config, contentRoot), userId, "media");

    // Soft-delete bin: a user's orphaned media is moved here, never hard-deleted.
    public static string UserTrashDir(IConfiguration config, string contentRoot, string userId)
        => Path.Combine(UsersDir(config, contentRoot), userId, ".trash");

    // Timestamped version history per note, kept under the user's hidden .papyra
    // dir (NOT the notes vault — the watcher must never see snapshot churn).
    public static string UserSnapshotsDir(IConfiguration config, string contentRoot, string userId)
        => Path.Combine(UsersDir(config, contentRoot), userId, ".papyra", "snapshots");

    public static string DbPath(IConfiguration config, string contentRoot)
        => Path.Combine(DotPapyra(config, contentRoot), "papyra.db");

    // Disposable Lucene full-text index — rebuilt from the .md files at will.
    public static string LuceneIndexDir(IConfiguration config, string contentRoot)
        => Path.Combine(DotPapyra(config, contentRoot), "lucene-index");
}
