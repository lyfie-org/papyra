using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class ColdBootDiffServiceTests
{
    private const string Uid = "1";

    [Fact]
    public async Task ColdBoot_IndexesOfflineFiles_AndHydratesVault()
    {
        var usersDir = NewTempDir();
        var indexDir = NewTempDir();
        var notesDir = UserNotesDir(usersDir);
        var state = new VaultState();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            await File.WriteAllTextAsync(Path.Combine(notesDir, "a.md"), "---\nid: a1\ntitle: Alpha\n---\n\nfindme zzyzx");
            await File.WriteAllTextAsync(Path.Combine(notesDir, "b.md"), "---\nid: b1\ntitle: Beta\n---\n\nplain");

            await NewService(usersDir, state, search).RunDiffAsync(db, default);

            Assert.Equal(2, state.Count(Uid));                       // vault hydrated from disk
            Assert.Equal("a1", search.Search(Uid, "zzyzx").Single().Id); // offline file indexed
            Assert.Equal(2, await db.NoteCache.CountAsync());        // cache populated
        }
        finally
        {
            db.Dispose();
            search.Dispose(); // release write.lock before deleting the index dir
            CleanUp(usersDir, indexDir);
        }
    }

    [Fact]
    public async Task ColdBoot_PrunesNotesDeletedWhileOffline()
    {
        var usersDir = NewTempDir();
        var indexDir = NewTempDir();
        var notesDir = UserNotesDir(usersDir);
        var state = new VaultState();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            // "gone" was indexed/cached last run but its .md no longer exists on disk.
            search.IndexNote(Uid, new Note { Id = "gone", Title = "Ghost", Body = "vanishedtoken" });
            db.NoteCache.Add(new NoteCache { UserId = Uid, Id = "gone", Title = "Ghost", LastModified = DateTime.UtcNow });
            await db.SaveChangesAsync();

            await File.WriteAllTextAsync(Path.Combine(notesDir, "live.md"), "---\nid: live1\ntitle: Live\n---\n\nstays");

            await NewService(usersDir, state, search).RunDiffAsync(db, default);

            Assert.Empty(search.Search(Uid, "vanishedtoken"));       // dropped from index
            Assert.Null(await db.NoteCache.FindAsync(Uid, "gone"));  // dropped from cache
            Assert.Equal(1, state.Count(Uid));                       // only the live note
        }
        finally
        {
            db.Dispose();
            search.Dispose(); // release write.lock before deleting the index dir
            CleanUp(usersDir, indexDir);
        }
    }

    // ── Multi-tenant id collisions ────────────────────────────────────────────
    // A note id is unique only *within* a vault. Two tenants sharing one is
    // ordinary — every user who has been @mentioned owns a note with id "Inbox"
    // — and these are the paths that used to treat it as globally unique.

    [Fact]
    public async Task ColdBoot_SurvivesTheSameNoteIdInTwoVaults()
    {
        var usersDir = NewTempDir();
        var indexDir = NewTempDir();
        var search = new SearchIndexService(indexDir);
        var state = new VaultState();
        var db = NewDb();
        try
        {
            // Exactly the shape Phase 15 guarantees: both tenants own "Inbox".
            foreach (var uid in new[] { "1", "2" })
            {
                var dir = Path.Combine(usersDir, uid, "notes");
                Directory.CreateDirectory(dir);
                await File.WriteAllTextAsync(
                    Path.Combine(dir, "Inbox.md"),
                    $"---\nid: Inbox\ntitle: Inbox\nkind: inbox\n---\n\nping for user {uid}");
            }

            // Previously threw "another instance with the same key value for
            // {'Id'} is already being tracked" — out of StartAsync, before
            // Kestrel bound its ports, so the container never came up at all.
            await NewService(usersDir, state, search).RunDiffAsync(db, default);

            Assert.Equal(2, await db.NoteCache.CountAsync());
            Assert.NotNull(await db.NoteCache.FindAsync("1", "Inbox"));
            Assert.NotNull(await db.NoteCache.FindAsync("2", "Inbox"));
            Assert.Equal(1, state.Count("1"));
            Assert.Equal(1, state.Count("2"));
        }
        finally
        {
            db.Dispose();
            search.Dispose();
            CleanUp(usersDir, indexDir);
        }
    }

    [Fact]
    public async Task ColdBoot_KeepsBothTenantsSearchableForASharedNoteId()
    {
        var usersDir = NewTempDir();
        var indexDir = NewTempDir();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            foreach (var (uid, token) in new[] { ("1", "alphatoken"), ("2", "betatoken") })
            {
                var dir = Path.Combine(usersDir, uid, "notes");
                Directory.CreateDirectory(dir);
                await File.WriteAllTextAsync(
                    Path.Combine(dir, "Inbox.md"),
                    $"---\nid: Inbox\ntitle: Inbox\n---\n\n{token}");
            }

            await NewService(usersDir, new VaultState(), search).RunDiffAsync(db, default);

            // Indexing was keyed on the bare note id, so the second tenant's
            // document replaced the first's and one user lost their note from
            // search entirely.
            Assert.Equal("Inbox", search.Search("1", "alphatoken").Single().Id);
            Assert.Equal("Inbox", search.Search("2", "betatoken").Single().Id);
            // Still fenced: neither tenant can see the other's copy.
            Assert.Empty(search.Search("1", "betatoken"));
            Assert.Empty(search.Search("2", "alphatoken"));
        }
        finally
        {
            db.Dispose();
            search.Dispose();
            CleanUp(usersDir, indexDir);
        }
    }

    [Fact]
    public async Task ColdBoot_PruningOneTenantLeavesTheOthersSharedIdAlone()
    {
        var usersDir = NewTempDir();
        var indexDir = NewTempDir();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            // Tenant 2 still has Inbox on disk; tenant 1's was deleted offline
            // but its cache row survives, so the prune path runs for ("1","Inbox").
            var dir2 = Path.Combine(usersDir, "2", "notes");
            Directory.CreateDirectory(dir2);
            await File.WriteAllTextAsync(
                Path.Combine(dir2, "Inbox.md"), "---\nid: Inbox\ntitle: Inbox\n---\n\nkeptoken");
            Directory.CreateDirectory(Path.Combine(usersDir, "1", "notes"));

            search.IndexNote("1", new Note { Id = "Inbox", Title = "Inbox", Body = "goneToken" });
            db.NoteCache.Add(new NoteCache { UserId = "1", Id = "Inbox", Title = "Inbox", LastModified = DateTime.UtcNow });
            await db.SaveChangesAsync();

            await NewService(usersDir, new VaultState(), search).RunDiffAsync(db, default);

            // Deleting by the bare id would have taken tenant 2's live note with it.
            Assert.Equal("Inbox", search.Search("2", "keptoken").Single().Id);
            Assert.NotNull(await db.NoteCache.FindAsync("2", "Inbox"));
            Assert.Null(await db.NoteCache.FindAsync("1", "Inbox"));
        }
        finally
        {
            db.Dispose();
            search.Dispose();
            CleanUp(usersDir, indexDir);
        }
    }

    // Build (and create) tenant "1"'s notes dir under a users-root.
    private static string UserNotesDir(string usersDir)
    {
        var dir = Path.Combine(usersDir, Uid, "notes");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static ColdBootDiffService NewService(string usersDir, VaultState state, SearchIndexService search)
    {
        var sp = new ServiceCollection().BuildServiceProvider();
        return new ColdBootDiffService(
            new VaultObserverOptions { UsersDir = usersDir },
            new MarkdownStorageService(),
            state,
            search,
            sp.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ColdBootDiffService>.Instance);
    }

    private static AppDbContext NewDb()
    {
        var conn = new SqliteConnection("DataSource=:memory:");
        conn.Open(); // keep the in-memory db alive for the context's lifetime
        var opts = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(conn).Options;
        var db = new AppDbContext(opts);
        db.Database.EnsureCreated();
        return db;
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-cbd-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static void CleanUp(params string[] dirs)
    {
        foreach (var d in dirs)
            if (Directory.Exists(d)) Directory.Delete(d, recursive: true);
    }
}
