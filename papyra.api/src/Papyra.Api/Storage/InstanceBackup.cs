using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

/// <summary>Setting keys for the instance backup. See <see cref="InstanceBackupService"/>.</summary>
public static class InstanceBackupKeys
{
    /// <summary>The backup passphrase, sealed with ASP.NET Data Protection so the schedule can use it unattended.</summary>
    public const string Passphrase = "instancebackup.passphrase";
    public const string Local = "instancebackup.local";
    public const string Keep = "instancebackup.keep";
    public const string GitRemote = "instancebackup.git.remote";
    public const string GitBranch = "instancebackup.git.branch";
    public const string GitToken = "instancebackup.git.token";
    public const string LastLocalUtc = "instancebackup.lastLocalUtc";
    public const string LastGitUtc = "instancebackup.lastGitUtc";
    public const string LastError = "instancebackup.lastError";
}

/// <summary>What is inside an instance backup, written as <c>papyra-instance-backup.json</c>.</summary>
public sealed record InstanceBackupManifest(string Format, int Version, string CreatedUtc, string? Schema)
{
    public const string FileName = "papyra-instance-backup.json";
    public const string FormatName = "papyra-instance-backup";
    public const int CurrentVersion = 1;
}

public sealed record InstanceCopy(string Name, long Bytes, DateTime ModifiedUtc);

public sealed record InstanceBackupStatus(
    bool PassphraseSet, bool Local, int Keep, string GitRemote, string GitBranch, bool GitTokenSet,
    string? LastLocalUtc, string? LastGitUtc, string? LastError, IReadOnlyList<InstanceCopy> Copies);

/// <summary>What a staged restore holds, for the confirm screen.</summary>
public sealed record InstanceRestoreSummary(string RestoreId, int Users, string? CreatedUtc, string? Schema);

/// <summary>A restore the person can fix and retry (wrong passphrase, wrong file), as opposed to a crash.</summary>
public sealed class InstanceRestoreException(string message) : Exception(message);

/// <summary>
/// The instance backup: everything in <c>papyra.db</c> that no per-account backup
/// carries (accounts, passkeys, TOTP, sharing, API keys, webhooks, comments and
/// the SMTP/SSO settings), together with the Data Protection key ring that seals
/// some of it.
///
/// A bundle is a consistent snapshot of the database (<c>VACUUM INTO</c>, safe
/// while the app is writing) with the rebuildable caches emptied, plus
/// <c>.papyra/keys/</c>, zipped and sealed under a passphrase the admin chose
/// (<see cref="EncryptedBackupService"/>). The key ring has to travel with it:
/// TOTP secrets and stored git keys are sealed by it, so a database restored
/// without it comes back with authenticators that can never verify.
///
/// It does not hold notes. Those are the files in <c>users/</c>, or each
/// account's own backup.
/// </summary>
public sealed class InstanceBackupService
{
    public const string Extension = ".papyra-instance";
    internal const string DbFile = "papyra.db";
    internal const string KeysDir = "keys";

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly InstanceConfigStore _settings;
    private readonly EncryptedBackupService _crypto;
    private readonly IDataProtector _protector;
    private readonly ILogger<InstanceBackupService> _logger;
    // One bundle at a time: the schedule, "Back up now" and a download all stage a snapshot.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public InstanceBackupService(
        IServiceScopeFactory scopes, IConfiguration config, IHostEnvironment env, InstanceConfigStore settings,
        EncryptedBackupService crypto, IDataProtectionProvider dataProtection, ILogger<InstanceBackupService> logger)
    {
        _scopes = scopes;
        _config = config;
        _env = env;
        _settings = settings;
        _crypto = crypto;
        _protector = dataProtection.CreateProtector("Papyra.InstanceBackup.v1");
        _logger = logger;
    }

    public static string? PassphraseProblem(string? passphrase) =>
        string.IsNullOrEmpty(passphrase) || passphrase.Length < 12 ? "Use at least 12 characters." : null;

    private string DotPapyra => PapyraPaths.DotPapyra(_config, _env.ContentRootPath);
    private string CopiesDir => Path.Combine(DotPapyra, "instance-backups");

    public bool HasPassphrase => PassphraseOrNull() is not null;

    public async Task SetPassphraseAsync(string passphrase, CancellationToken ct) =>
        await _settings.SetAsync(new Dictionary<string, string?> { [InstanceBackupKeys.Passphrase] = _protector.Protect(passphrase) }, ct);

    private string? PassphraseOrNull()
    {
        var sealedValue = _settings.Get(InstanceBackupKeys.Passphrase);
        if (string.IsNullOrEmpty(sealedValue)) return null;
        try { return _protector.Unprotect(sealedValue); }
        catch (CryptographicException) { return null; } // sealed by a key ring this server no longer has
    }

    // ── Building ────────────────────────────────────────────────────────────────

    /// <summary>Lay the bundle's plain contents out under <paramref name="stage"/>.</summary>
    internal async Task StageAsync(string stage, CancellationToken ct)
    {
        Directory.CreateDirectory(stage);
        var snapshot = Path.Combine(stage, DbFile);
        string? schema;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"VACUUM INTO {snapshot}", ct);
            schema = (await db.Database.GetAppliedMigrationsAsync(ct)).LastOrDefault();
        }

        // Caches the cold-boot diff refills from the files; they would only make the bundle big.
        using (var conn = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = snapshot, Pooling = false }.ToString()))
        {
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM NoteCache; DELETE FROM NoteEmbeddings; PRAGMA journal_mode=DELETE; VACUUM;";
            cmd.ExecuteNonQuery();
        }

        var keys = PapyraPaths.DataProtectionKeysDir(_config, _env.ContentRootPath);
        var keysOut = Path.Combine(stage, KeysDir);
        Directory.CreateDirectory(keysOut);
        if (Directory.Exists(keys))
            foreach (var file in Directory.EnumerateFiles(keys))
                File.Copy(file, Path.Combine(keysOut, Path.GetFileName(file)));

        var manifest = new InstanceBackupManifest(
            InstanceBackupManifest.FormatName, InstanceBackupManifest.CurrentVersion, DateTime.UtcNow.ToString("o"), schema);
        await File.WriteAllTextAsync(Path.Combine(stage, InstanceBackupManifest.FileName),
            JsonSerializer.Serialize(manifest, GitSyncService.JsonOpts), ct);
    }

    /// <summary>Stream a sealed bundle to <paramref name="destination"/>.</summary>
    public async Task WriteBundleAsync(Stream destination, CancellationToken ct)
    {
        var passphrase = PassphraseOrNull() ?? throw new InvalidOperationException("No backup passphrase is set.");
        await _gate.WaitAsync(ct);
        var work = Path.Combine(Path.GetTempPath(), $"papyra-instance-{Guid.NewGuid():N}");
        try
        {
            await StageAsync(Path.Combine(work, "stage"), ct);
            await _crypto.BackupAsync([(string.Empty, Path.Combine(work, "stage"))], passphrase, destination, ct);
        }
        finally
        {
            _gate.Release();
            TryDelete(work);
        }
    }

    // ── The schedule ────────────────────────────────────────────────────────────

    /// <summary>
    /// One scheduled pass: a local copy and/or a push to the git remote, as set up.
    /// Throws when any destination failed, so the Jobs screen shows it red.
    /// </summary>
    public async Task<string?> RunAsync(CancellationToken ct)
    {
        await _settings.EnsureLoadedAsync(ct);
        var local = _settings.GetBool(InstanceBackupKeys.Local);
        var remote = _settings.GetOrEmpty(InstanceBackupKeys.GitRemote);
        if (!local && remote.Length == 0) return null;

        var work = Path.Combine(Path.GetTempPath(), $"papyra-instance-{Guid.NewGuid():N}");
        Directory.CreateDirectory(work);
        var bundle = Path.Combine(work, "bundle" + Extension);
        var done = new List<string>();
        var failed = new List<string>();
        try
        {
            if (!HasPassphrase) throw new InvalidOperationException("The backup passphrase is missing. Set it again in Server settings → Server backup.");
            await using (var fs = new FileStream(bundle, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await WriteBundleAsync(fs, ct);

            var updates = new Dictionary<string, string?>();
            var stamp = DateTime.UtcNow.ToString("o");

            if (local)
            {
                try
                {
                    Directory.CreateDirectory(CopiesDir);
                    File.Copy(bundle, Path.Combine(CopiesDir, $"papyra-instance-{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}{Extension}"));
                    Prune(Math.Clamp(_settings.GetInt(InstanceBackupKeys.Keep, 7), 1, 60));
                    updates[InstanceBackupKeys.LastLocalUtc] = stamp;
                    done.Add("kept a local copy");
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    failed.Add($"local copy: {ex.Message}");
                }
            }

            if (remote.Length > 0)
            {
                var content = Path.Combine(work, "git");
                Directory.CreateDirectory(content);
                File.Copy(bundle, Path.Combine(content, "papyra-instance-backup" + Extension));
                await File.WriteAllTextAsync(Path.Combine(content, "README.md"), GitReadme, ct);
                var branch = _settings.GetOrEmpty(InstanceBackupKeys.GitBranch);
                var result = await Task.Run(() => GitSyncService.RunSync(
                    Path.Combine(DotPapyra, "instance-git-mirror"), content, remote,
                    branch.Length == 0 ? "main" : branch, _settings.Get(InstanceBackupKeys.GitToken)), ct);
                if (result.Status is "pushed" or "clean")
                {
                    updates[InstanceBackupKeys.LastGitUtc] = stamp;
                    done.Add("pushed to git");
                }
                else failed.Add($"git: {result.Detail ?? result.Status}");
            }

            updates[InstanceBackupKeys.LastError] = failed.Count == 0 ? string.Empty : string.Join("; ", failed);
            await _settings.SetAsync(updates, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Instance backup failed");
            await _settings.SetAsync(new Dictionary<string, string?> { [InstanceBackupKeys.LastError] = ex.Message }, ct);
            throw;
        }
        finally { TryDelete(work); }

        if (failed.Count > 0) throw new InvalidOperationException(string.Join("; ", failed));
        return string.Join(" and ", done);
    }

    private const string GitReadme =
        "# Papyra server backup\n\n"
        + "`papyra-instance-backup.papyra-instance` is an encrypted copy of this Papyra's accounts, passkeys,\n"
        + "sharing and settings, with the key ring that seals them. It does not hold notes.\n\n"
        + "To restore it, choose \"Restore a whole server\" on a new Papyra's first screen, or Server settings →\n"
        + "Server backup on a running one, and give it this repository and the backup passphrase.\n"
        + "Without the passphrase it cannot be read by anyone.\n";

    private void Prune(int keep)
    {
        var old = Directory.GetFiles(CopiesDir, "*" + Extension)
            .OrderByDescending(f => Path.GetFileName(f), StringComparer.Ordinal)
            .Skip(keep);
        foreach (var file in old) File.Delete(file);
    }

    public InstanceBackupStatus Status()
    {
        var copies = Directory.Exists(CopiesDir)
            ? Directory.GetFiles(CopiesDir, "*" + Extension)
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.Name, StringComparer.Ordinal)
                .Select(f => new InstanceCopy(f.Name, f.Length, f.LastWriteTimeUtc))
                .ToList()
            : [];
        string? Some(string key) => _settings.Has(key) ? _settings.Get(key) : null;
        return new InstanceBackupStatus(
            HasPassphrase, _settings.GetBool(InstanceBackupKeys.Local), Math.Clamp(_settings.GetInt(InstanceBackupKeys.Keep, 7), 1, 60),
            _settings.GetOrEmpty(InstanceBackupKeys.GitRemote), _settings.GetOrEmpty(InstanceBackupKeys.GitBranch),
            _settings.Has(InstanceBackupKeys.GitToken), Some(InstanceBackupKeys.LastLocalUtc), Some(InstanceBackupKeys.LastGitUtc),
            Some(InstanceBackupKeys.LastError), copies);
    }

    // ── Restoring ───────────────────────────────────────────────────────────────

    private string StagingRoot => Path.Combine(DotPapyra, "restore-staging");

    /// <summary>
    /// Decrypt a bundle into staging and check it, without touching anything live.
    /// A wrong passphrase, a file that is not a bundle, or one from a newer Papyra
    /// raises <see cref="InstanceRestoreException"/> with a message to show.
    /// </summary>
    public async Task<InstanceRestoreSummary> StageRestoreAsync(Stream source, string passphrase, CancellationToken ct)
    {
        TryDelete(StagingRoot); // one staged restore at a time
        var id = Guid.NewGuid().ToString("N");
        var dir = Path.Combine(StagingRoot, id);
        Directory.CreateDirectory(dir);
        try
        {
            try { await _crypto.RestoreAsync(source, passphrase, dir, ct); }
            catch (CryptographicException) { throw new InstanceRestoreException("That passphrase doesn't open this backup."); }
            catch (InvalidDataException) { throw new InstanceRestoreException("That isn't a Papyra server backup, or it is damaged."); }

            var manifestPath = Path.Combine(dir, InstanceBackupManifest.FileName);
            if (!File.Exists(manifestPath) || !File.Exists(Path.Combine(dir, DbFile)))
                throw new InstanceRestoreException("That is a Papyra backup, but not a server backup. It holds notes, not accounts and settings.");

            var manifest = JsonSerializer.Deserialize<InstanceBackupManifest>(await File.ReadAllTextAsync(manifestPath, ct), GitSyncService.JsonOpts);
            if (manifest is null || manifest.Format != InstanceBackupManifest.FormatName)
                throw new InstanceRestoreException("That isn't a Papyra server backup, or it is damaged.");
            if (manifest.Version > InstanceBackupManifest.CurrentVersion)
                throw new InstanceRestoreException("This backup was made by a newer Papyra. Update Papyra first, then restore it.");

            HashSet<string> known;
            using (var scope = _scopes.CreateScope())
                known = scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.GetMigrations().ToHashSet(StringComparer.Ordinal);
            var users = ReadSnapshot(Path.Combine(dir, DbFile), known);

            return new InstanceRestoreSummary(id, users, manifest.CreatedUtc, manifest.Schema);
        }
        catch
        {
            TryDelete(dir);
            throw;
        }
    }

    /// <summary>Stage a restore from a sealed bundle held in a git repository.</summary>
    public async Task<InstanceRestoreSummary> StageRestoreFromGitAsync(
        string remote, string branch, string? token, string passphrase, CancellationToken ct)
    {
        var clone = Path.Combine(Path.GetTempPath(), $"papyra-instance-clone-{Guid.NewGuid():N}");
        try
        {
            var problem = await Task.Run(() => GitSyncService.CloneForRestore(remote, string.IsNullOrWhiteSpace(branch) ? "main" : branch.Trim(), token, clone), ct);
            if (problem is not null) throw new InstanceRestoreException(problem);
            var file = Path.Combine(clone, "papyra-instance-backup" + Extension);
            if (!File.Exists(file)) throw new InstanceRestoreException("That repository has no Papyra server backup in it.");
            await using var fs = File.OpenRead(file);
            return await StageRestoreAsync(fs, passphrase, ct);
        }
        finally { TryForceDelete(clone); }
    }

    // Opens the staged database read-only: the account count for the confirm screen,
    // and a refusal if it was written by a Papyra newer than this one (it could not
    // be migrated back down).
    private static int ReadSnapshot(string dbFile, HashSet<string> known)
    {
        try
        {
            using var conn = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbFile, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
            conn.Open();
            using var applied = conn.CreateCommand();
            applied.CommandText = "SELECT MigrationId FROM __EFMigrationsHistory";
            using (var reader = applied.ExecuteReader())
                while (reader.Read())
                    if (!known.Contains(reader.GetString(0)))
                        throw new InstanceRestoreException("This backup was made by a newer Papyra. Update Papyra first, then restore it.");

            using var count = conn.CreateCommand();
            count.CommandText = "SELECT COUNT(*) FROM Users";
            return Convert.ToInt32(count.ExecuteScalar());
        }
        catch (SqliteException)
        {
            throw new InstanceRestoreException("The database inside that backup can't be read.");
        }
    }

    /// <summary>
    /// Queue a staged restore to be applied at the next start. The live database
    /// and key ring are in use right now (and the key ring is cached in memory),
    /// so the swap happens at boot, before either is opened. See
    /// <see cref="PendingInstanceRestore"/>. Returns false when the id is unknown.
    /// </summary>
    public bool Queue(string restoreId)
    {
        if (restoreId.Length != 32 || !restoreId.All(Uri.IsHexDigit)) return false;
        var staged = Path.Combine(StagingRoot, restoreId);
        if (!Directory.Exists(staged)) return false;
        var pending = PendingInstanceRestore.PendingDir(_config, _env.ContentRootPath);
        TryDelete(pending);
        Directory.Move(staged, pending);
        TryDelete(StagingRoot);
        return true;
    }

    private static void TryDelete(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
        catch (IOException) { /* a temp dir; the OS reclaims it */ }
        catch (UnauthorizedAccessException) { }
    }

    // A git clone holds read-only object files, which Directory.Delete refuses on Windows.
    private static void TryForceDelete(string dir)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        TryDelete(dir);
    }
}

/// <summary>
/// Applies a queued instance restore at start-up, before the database or the key
/// ring is opened. What it replaces is moved to <c>.papyra/replaced-by-restore-*</c>,
/// not deleted, so a restore that turns out to be the wrong one can be undone by
/// moving the folder back.
/// </summary>
public static class PendingInstanceRestore
{
    public static string PendingDir(IConfiguration config, string contentRoot) =>
        Path.Combine(PapyraPaths.DotPapyra(config, contentRoot), "pending-restore");

    public static bool ApplyIfAny(IConfiguration config, string contentRoot, ILogger log)
    {
        var pending = PendingDir(config, contentRoot);
        if (!Directory.Exists(pending)) return false;

        var newDb = Path.Combine(pending, InstanceBackupService.DbFile);
        if (!File.Exists(newDb))
        {
            log.LogWarning("Ignoring a queued restore with no database in it");
            Directory.Delete(pending, recursive: true);
            return false;
        }

        var db = PapyraPaths.DbPath(config, contentRoot);
        var keys = PapyraPaths.DataProtectionKeysDir(config, contentRoot);
        var aside = Path.Combine(PapyraPaths.DotPapyra(config, contentRoot), $"replaced-by-restore-{DateTime.UtcNow:yyyyMMdd-HHmmss}");
        Directory.CreateDirectory(aside);
        SqliteConnection.ClearAllPools();

        foreach (var file in new[] { db, db + "-wal", db + "-shm" })
            if (File.Exists(file)) File.Move(file, Path.Combine(aside, Path.GetFileName(file)));
        if (Directory.Exists(keys)) Directory.Move(keys, Path.Combine(aside, InstanceBackupService.KeysDir));

        Directory.CreateDirectory(Path.GetDirectoryName(db)!);
        File.Move(newDb, db);
        var newKeys = Path.Combine(pending, InstanceBackupService.KeysDir);
        if (Directory.Exists(newKeys)) Directory.Move(newKeys, keys);
        else Directory.CreateDirectory(keys);

        Directory.Delete(pending, recursive: true);
        log.LogWarning("Restored the instance backup: accounts, settings and keys replaced. The previous ones are in {Aside}", aside);
        return true;
    }
}

/// <summary>Daily instance backup, to the places the admin chose. See <see cref="InstanceBackupService"/>.</summary>
public sealed class InstanceBackupJob(InstanceBackupService backup, JobRegistry registry) : PeriodicJob(registry)
{
    protected override string JobId => "instance-backup";
    protected override string JobName => "Back up accounts and settings";
    protected override string JobDescription =>
        "Makes an encrypted copy of the accounts, passkeys, sharing and settings, with the keys that seal them, "
        + "and keeps it locally and/or pushes it to your git repository, as set in Server settings → Server backup. "
        + "Does nothing until one is chosen.";
    protected override TimeSpan Interval => TimeSpan.FromHours(24);
    // After the cold-boot scan and the first search rebuild, not alongside them.
    protected override TimeSpan StartupDelay => TimeSpan.FromMinutes(20);

    protected override Task<string?> RunOnceAsync(CancellationToken ct) => backup.RunAsync(ct);
}
