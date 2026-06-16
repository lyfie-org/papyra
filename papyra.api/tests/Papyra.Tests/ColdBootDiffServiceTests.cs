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
    [Fact]
    public async Task ColdBoot_IndexesOfflineFiles_AndHydratesVault()
    {
        var notesDir = NewTempDir();
        var indexDir = NewTempDir();
        var state = new VaultState();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            await File.WriteAllTextAsync(Path.Combine(notesDir, "a.md"), "---\nid: a1\ntitle: Alpha\n---\n\nfindme zzyzx");
            await File.WriteAllTextAsync(Path.Combine(notesDir, "b.md"), "---\nid: b1\ntitle: Beta\n---\n\nplain");

            await NewService(notesDir, state, search).RunDiffAsync(db, default);

            Assert.Equal(2, state.Count);                       // vault hydrated from disk
            Assert.Equal("a1", search.Search("zzyzx").Single().Id); // offline file indexed
            Assert.Equal(2, await db.NoteCache.CountAsync());   // cache populated
        }
        finally
        {
            db.Dispose();
            search.Dispose(); // release write.lock before deleting the index dir
            CleanUp(notesDir, indexDir);
        }
    }

    [Fact]
    public async Task ColdBoot_PrunesNotesDeletedWhileOffline()
    {
        var notesDir = NewTempDir();
        var indexDir = NewTempDir();
        var state = new VaultState();
        var search = new SearchIndexService(indexDir);
        var db = NewDb();
        try
        {
            // "gone" was indexed/cached last run but its .md no longer exists on disk.
            search.IndexNote(new Note { Id = "gone", Title = "Ghost", Body = "vanishedtoken" });
            db.NoteCache.Add(new NoteCache { Id = "gone", Title = "Ghost", LastModified = DateTime.UtcNow });
            await db.SaveChangesAsync();

            await File.WriteAllTextAsync(Path.Combine(notesDir, "live.md"), "---\nid: live1\ntitle: Live\n---\n\nstays");

            await NewService(notesDir, state, search).RunDiffAsync(db, default);

            Assert.Empty(search.Search("vanishedtoken"));            // dropped from index
            Assert.Null(await db.NoteCache.FindAsync("gone"));       // dropped from cache
            Assert.Equal(1, state.Count);                            // only the live note
        }
        finally
        {
            db.Dispose();
            search.Dispose(); // release write.lock before deleting the index dir
            CleanUp(notesDir, indexDir);
        }
    }

    private static ColdBootDiffService NewService(string notesDir, VaultState state, SearchIndexService search)
    {
        var sp = new ServiceCollection().BuildServiceProvider();
        return new ColdBootDiffService(
            new VaultObserverOptions { NotesDir = notesDir },
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
