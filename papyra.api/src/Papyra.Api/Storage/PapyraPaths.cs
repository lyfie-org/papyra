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

    // The user-facing notes vault: the .md files are the source of truth.
    public static string NotesDir(IConfiguration config, string contentRoot)
        => Path.Combine(DataDir(config, contentRoot), "notes");

    public static string DbPath(IConfiguration config, string contentRoot)
        => Path.Combine(DotPapyra(config, contentRoot), "papyra.db");

    // Disposable Lucene full-text index — rebuilt from the .md files at will.
    public static string LuceneIndexDir(IConfiguration config, string contentRoot)
        => Path.Combine(DotPapyra(config, contentRoot), "lucene-index");

    // Uploaded attachments referenced by notes via ![[filename]].
    public static string MediaDir(IConfiguration config, string contentRoot)
        => Path.Combine(DataDir(config, contentRoot), "media");

    // Soft-delete bin: orphaned media is moved here, never hard-deleted.
    public static string TrashDir(IConfiguration config, string contentRoot)
        => Path.Combine(DataDir(config, contentRoot), ".trash");
}
