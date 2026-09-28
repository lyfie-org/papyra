using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// What a backup holds, written as <c>papyra-backup.json</c> at its root. No
/// timestamp: git records when, and a field that changed every pass would make
/// every sync a commit.
/// </summary>
public sealed record BackupManifest(
    string Format, int Version, bool Encrypted,
    BackupCounts? Counts = null, EncryptedGitHeader? Crypto = null)
{
    public const string FileName = "papyra-backup.json";
    public const string FormatName = "papyra-backup";
    public const int CurrentVersion = 2;
}

public sealed record BackupCounts(int Notes, int Todos, int Vault, int Media);

/// <summary>
/// The account preferences a backup carries, so a restore on a fresh install
/// brings the person's set-up back with their notes. Never the password hash or
/// the vault PIN: whoever restores sets those again.
/// </summary>
public sealed record BackupAccount(
    string? Username, string? Name, string? Email, string? TimeZone, string? Theme,
    bool? NotifyOnMention, bool? NotifyOnShare, string? NotificationPrefs);

/// <summary>What a staged backup contains, for the restore screen to show before anything is applied.</summary>
public sealed record BackupSummary(int Version, bool Legacy, BackupCounts Counts, BackupAccount? Account);

/// <summary>
/// The on-disk shape of a Papyra backup — the same tree for the git mirror, the
/// encrypted git mirror (file by file, see <see cref="EncryptedGitCodec"/>) and
/// the downloadable .papyra-vault (zipped, then encrypted):
///
/// <code>
/// papyra-backup.json        what this is (format, version, counts)
/// README.md                 how to read and restore it
/// notes/                    ordinary notes (.md, frontmatter + markdown)
/// todos/                    to-do lists
/// vault/                    locked (secure) notes
/// media/images|documents|videos|audio|other/
/// settings/account.json     profile + preferences (no password, no PIN)
/// settings/collections.json saved searches
/// settings/order.json, categories.json, avatar.*
/// </code>
///
/// The live vault keeps its own layout (one notes dir, one flat media dir) —
/// that is what the watcher, the index and every media link expect. This class
/// is the translation both ways. Version 1 backups (a bare notes/ + media/ pair)
/// still restore.
/// </summary>
public sealed class BackupLayout
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly string[] NoteFolders = ["notes", "todos", "vault"];
    public static readonly string[] MediaFolders = ["images", "documents", "videos", "audio", "other"];

    private readonly MarkdownStorageService _storage;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;

    public BackupLayout(MarkdownStorageService storage, IConfiguration config, IHostEnvironment env)
    {
        _storage = storage;
        _config = config;
        _env = env;
    }

    public static string MediaFolder(string fileName) => Path.GetExtension(fileName).ToLowerInvariant() switch
    {
        ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".avif" or ".bmp" or ".svg" or ".heic" or ".heif" or ".ico" or ".tif" or ".tiff" => "images",
        ".mp4" or ".webm" or ".mov" or ".mkv" or ".avi" or ".m4v" or ".ogv" => "videos",
        ".mp3" or ".wav" or ".ogg" or ".oga" or ".m4a" or ".aac" or ".flac" or ".opus" or ".weba" => "audio",
        ".pdf" or ".doc" or ".docx" or ".xls" or ".xlsx" or ".ppt" or ".pptx" or ".odt" or ".ods" or ".odp"
            or ".txt" or ".md" or ".csv" or ".rtf" or ".epub" or ".json" or ".html" or ".htm" or ".zip" => "documents",
        _ => "other",
    };

    // ── Build ───────────────────────────────────────────────────────────────────

    /// <summary>Write <paramref name="user"/>'s notes, media and settings into <paramref name="dest"/> in the backup layout.</summary>
    public async Task<BackupCounts> BuildAsync(User user, AppDbContext db, string dest, CancellationToken ct)
    {
        var root = _env.ContentRootPath;
        var uid = user.Id.ToString();
        Directory.CreateDirectory(dest);
        int notes = 0, todos = 0, vault = 0, media = 0;

        var notesDir = PapyraPaths.UserNotesDir(_config, root, uid);
        if (Directory.Exists(notesDir))
        {
            foreach (var file in Directory.EnumerateFiles(notesDir, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(notesDir, file);
                var folder = "notes";
                if (file.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                {
                    var note = await _storage.ReadAsync(file, ct);
                    if (note?.Secure == true) { folder = "vault"; vault++; }
                    else if (note?.Kind == "todo") { folder = "todos"; todos++; }
                    else notes++;
                }
                CopyInto(file, Path.Combine(dest, folder, rel));
            }
        }

        var mediaDir = PapyraPaths.UserMediaDir(_config, root, uid);
        if (Directory.Exists(mediaDir))
        {
            foreach (var file in Directory.EnumerateFiles(mediaDir, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(mediaDir, file);
                CopyInto(file, Path.Combine(dest, "media", MediaFolder(file), rel));
                media++;
            }
        }

        var settings = Path.Combine(dest, "settings");
        Directory.CreateDirectory(settings);
        var account = new BackupAccount(
            user.Username, user.Name, user.Email, user.TimeZone, user.Theme,
            user.NotifyOnMention, user.NotifyOnShare, user.NotificationPrefs);
        await WriteJsonAsync(Path.Combine(settings, "account.json"), account, ct);

        var collections = await db.SmartCollections.Where(c => c.UserId == user.Id)
            .OrderBy(c => c.Id).Select(c => new { c.Name, c.RulesJson, c.CreatedUtc }).ToListAsync(ct);
        await WriteJsonAsync(Path.Combine(settings, "collections.json"), collections, ct);

        var dot = PapyraPaths.UserDotPapyra(_config, root, uid);
        foreach (var name in new[] { "order.json", "categories.json" })
            if (File.Exists(Path.Combine(dot, name))) CopyInto(Path.Combine(dot, name), Path.Combine(settings, name));
        if (Directory.Exists(dot))
            foreach (var avatar in Directory.EnumerateFiles(dot, "avatar.*"))
                CopyInto(avatar, Path.Combine(settings, Path.GetFileName(avatar)));

        var counts = new BackupCounts(notes, todos, vault, media);
        await WriteJsonAsync(Path.Combine(dest, BackupManifest.FileName),
            new BackupManifest(BackupManifest.FormatName, BackupManifest.CurrentVersion, false, counts), ct);
        await File.WriteAllTextAsync(Path.Combine(dest, "README.md"), Readme(encrypted: false), ct);
        return counts;
    }

    public static string Readme(bool encrypted) => encrypted
        ? """
          # Papyra backup (encrypted)

          Everything in this repository is encrypted with a key only your Papyra
          password can unlock. File names are hashed; the folders say what kind of
          thing each file is:

          - `notes/`, `todos/`, `vault/` — notes, to-do lists and locked notes
          - `media/images`, `media/documents`, `media/videos`, `media/audio`, `media/other`
          - `settings/` — your profile and preferences

          To restore: on a new Papyra, choose **Restore from a backup → GitHub** during
          setup, paste this repository's address and an access token, then enter the
          password you used when this backup was made.
          """
        : """
          # Papyra backup

          Plain files you can read with anything:

          - `notes/` — your notes, as Markdown with YAML frontmatter
          - `todos/` — your to-do lists
          - `vault/` — your locked notes (**not encrypted here** — switch Papyra's
            backup to *Encrypted* if this repository could ever be seen by others)
          - `media/images`, `media/documents`, `media/videos`, `media/audio`, `media/other`
          - `settings/` — your profile and preferences (never your password or PIN)

          To restore: on a new Papyra, choose **Restore from a backup → GitHub** during
          setup, or in Settings → Backup.
          """;

    // ── Read ────────────────────────────────────────────────────────────────────

    public static BackupManifest? ReadManifest(string root)
    {
        var path = Path.Combine(root, BackupManifest.FileName);
        if (!File.Exists(path)) return null;
        try
        {
            var m = JsonSerializer.Deserialize<BackupManifest>(File.ReadAllText(path), Json);
            return m?.Format == BackupManifest.FormatName ? m : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>Count what a plain (decrypted) backup tree holds, and read its account preferences.</summary>
    public static BackupSummary Summarize(string root)
    {
        var manifest = ReadManifest(root);
        var legacy = manifest is null;
        int Count(string sub) => Directory.Exists(Path.Combine(root, sub))
            ? Directory.EnumerateFiles(Path.Combine(root, sub), "*.md", SearchOption.AllDirectories).Count() : 0;
        var mediaCount = Directory.Exists(Path.Combine(root, "media"))
            ? Directory.EnumerateFiles(Path.Combine(root, "media"), "*", SearchOption.AllDirectories).Count() : 0;
        var counts = new BackupCounts(Count("notes"), Count("todos"), Count("vault"), mediaCount);
        return new BackupSummary(manifest?.Version ?? 1, legacy, counts, ReadAccount(root));
    }

    public static BackupAccount? ReadAccount(string root)
    {
        var path = Path.Combine(root, "settings", "account.json");
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<BackupAccount>(File.ReadAllText(path), Json); }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Find the backup inside a checked-out repository: its root, or — for a
    /// repository the old git sync wrote, which mirrored a whole user directory —
    /// the folder holding <c>notes/</c>. Null when there is nothing Papyra-shaped.
    /// </summary>
    public static string? LocateRoot(string checkout)
    {
        if (File.Exists(Path.Combine(checkout, BackupManifest.FileName))) return checkout;
        if (Directory.Exists(Path.Combine(checkout, "notes"))) return checkout;
        return null;
    }

    // ── Apply ───────────────────────────────────────────────────────────────────

    /// <summary>
    /// Replace <paramref name="user"/>'s notes and media with a plain backup tree
    /// and bring back its settings. <paramref name="restoreProfile"/> also copies
    /// display name, time zone, theme and notification choices onto the account —
    /// what a fresh install wants; username and email are the caller's to decide.
    /// Returns how many notes were restored.
    /// </summary>
    public async Task ApplyAsync(string root, User user, AppDbContext db, bool restoreProfile, CancellationToken ct)
    {
        var contentRoot = _env.ContentRootPath;
        var uid = user.Id.ToString();

        // Gather the three note folders (or a v1 backup's single notes/) and the
        // media categories back into the live, flat shape, then swap contents in
        // place — clearing and refilling rather than moving the dirs keeps the
        // file watcher's handle valid.
        var gather = Path.Combine(PapyraPaths.UserDotPapyra(_config, contentRoot, uid), $"restore-{Guid.NewGuid():N}");
        try
        {
            var notesOut = Path.Combine(gather, "notes");
            var mediaOut = Path.Combine(gather, "media");
            Directory.CreateDirectory(notesOut);
            Directory.CreateDirectory(mediaOut);
            foreach (var folder in NoteFolders)
                MergeInto(Path.Combine(root, folder), notesOut);

            var mediaIn = Path.Combine(root, "media");
            var categorised = MediaFolders.Any(f => Directory.Exists(Path.Combine(mediaIn, f)));
            if (categorised)
                foreach (var folder in MediaFolders) MergeInto(Path.Combine(mediaIn, folder), mediaOut);
            else
                MergeInto(mediaIn, mediaOut);

            ReplaceDirContents(notesOut, PapyraPaths.UserNotesDir(_config, contentRoot, uid));
            ReplaceDirContents(mediaOut, PapyraPaths.UserMediaDir(_config, contentRoot, uid));
        }
        finally
        {
            if (Directory.Exists(gather)) Directory.Delete(gather, recursive: true);
        }

        var settings = Path.Combine(root, "settings");
        if (!Directory.Exists(settings)) return;

        var dot = PapyraPaths.UserDotPapyra(_config, contentRoot, uid);
        Directory.CreateDirectory(dot);
        foreach (var name in new[] { "order.json", "categories.json" })
            if (File.Exists(Path.Combine(settings, name))) AtomicCopy(Path.Combine(settings, name), Path.Combine(dot, name));
        var avatars = Directory.EnumerateFiles(settings, "avatar.*")
            .Where(a => Path.GetExtension(a).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".webp").ToList();
        if (avatars.Count > 0)
        {
            foreach (var old in Directory.EnumerateFiles(dot, "avatar.*")) File.Delete(old);
            AtomicCopy(avatars[0], Path.Combine(dot, Path.GetFileName(avatars[0]).ToLowerInvariant()));
        }

        var collectionsFile = Path.Combine(settings, "collections.json");
        if (File.Exists(collectionsFile))
        {
            try
            {
                var rows = JsonSerializer.Deserialize<List<CollectionRow>>(await File.ReadAllTextAsync(collectionsFile, ct), Json) ?? [];
                db.SmartCollections.RemoveRange(db.SmartCollections.Where(c => c.UserId == user.Id));
                foreach (var row in rows.Where(r => !string.IsNullOrWhiteSpace(r.Name)))
                    db.SmartCollections.Add(new SmartCollection
                    {
                        UserId = user.Id, Name = row.Name!.Trim(), RulesJson = row.RulesJson ?? string.Empty,
                        CreatedUtc = row.CreatedUtc ?? DateTime.UtcNow,
                    });
            }
            catch (JsonException) { /* a damaged collections file loses the saved searches, not the restore */ }
        }

        if (restoreProfile && ReadAccount(root) is { } account)
        {
            if (!string.IsNullOrWhiteSpace(account.Name) && account.Name.Length <= ProfileRules.MaxNameLength)
                user.Name = account.Name.Trim();
            if (!string.IsNullOrWhiteSpace(account.TimeZone) && TimeZoneInfo.TryFindSystemTimeZoneById(account.TimeZone, out _))
                user.TimeZone = account.TimeZone;
            if (account.Theme is "light" or "dark" or "system") user.Theme = account.Theme;
            if (account.NotifyOnMention is { } m) user.NotifyOnMention = m;
            if (account.NotifyOnShare is { } s) user.NotifyOnShare = s;
            if (account.NotificationPrefs is not null) user.NotificationPrefs = account.NotificationPrefs;
        }
        await db.SaveChangesAsync(ct);
    }

    private sealed record CollectionRow(string? Name, string? RulesJson, DateTime? CreatedUtc);

    // ── File helpers ────────────────────────────────────────────────────────────

    public static void ReplaceDirContents(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var f in Directory.EnumerateFiles(targetDir, "*", SearchOption.AllDirectories)) File.Delete(f);
        foreach (var d in Directory.EnumerateDirectories(targetDir)) Directory.Delete(d, recursive: true);

        if (!Directory.Exists(sourceDir)) return;
        foreach (var dir in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(targetDir, Path.GetRelativePath(sourceDir, dir)));
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
            File.Move(file, Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file)), overwrite: true);
    }

    private static void MergeInto(string sourceDir, string targetDir)
    {
        if (!Directory.Exists(sourceDir)) return;
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
            CopyInto(file, Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file)));
    }

    private static void CopyInto(string source, string dest)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        File.Copy(source, dest, overwrite: true);
    }

    private static void AtomicCopy(string source, string dest)
    {
        var tmp = dest + $".{Guid.NewGuid():N}.tmp";
        File.Copy(source, tmp, overwrite: true);
        File.Move(tmp, dest, overwrite: true);
    }

    private static async Task WriteJsonAsync<T>(string path, T value, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(value, Json), ct);
    }
}
