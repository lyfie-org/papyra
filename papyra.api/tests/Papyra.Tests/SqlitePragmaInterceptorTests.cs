using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Tests;

public sealed class SqlitePragmaInterceptorTests
{
    [Theory]
    [InlineData(true, "wal")]
    [InlineData(false, "delete")]
    public async Task JournalMode_FollowsTheSetting(bool wal, string expected)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-pragma-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var options = new DbContextOptionsBuilder<AppDbContext>()
                .UseSqlite($"Data Source={Path.Combine(dir, "t.db")}")
                .AddInterceptors(new SqlitePragmaInterceptor(wal))
                .Options;

            await using var db = new AppDbContext(options);
            await db.Database.EnsureCreatedAsync();
            var mode = await db.Database.SqlQueryRaw<string>("PRAGMA journal_mode").ToListAsync();

            Assert.Equal(expected, Assert.Single(mode));
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    // An install from before WAL: a migrated database in the rollback-journal mode.
    // Migrate() first looks for the file over a read-only connection, where the
    // journal mode cannot be changed. Starting on WAL must still work, and convert it.
    [Fact]
    public async Task AnExistingRollbackJournalDatabase_MigratesAndMovesToWal()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-pragma-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            DbContextOptions<AppDbContext> Options(bool wal) => new DbContextOptionsBuilder<AppDbContext>()
                .UseSqlite($"Data Source={Path.Combine(dir, "t.db")}")
                .AddInterceptors(new SqlitePragmaInterceptor(wal))
                .Options;

            await using (var db = new AppDbContext(Options(false))) await db.Database.MigrateAsync();
            SqliteConnection.ClearAllPools();

            await using (var db = new AppDbContext(Options(true)))
            {
                await db.Database.MigrateAsync();
                var mode = await db.Database.SqlQueryRaw<string>("PRAGMA journal_mode").ToListAsync();
                Assert.Equal("wal", Assert.Single(mode));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task TurningWalOff_RevertsADatabaseThatWasInWal()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-pragma-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            DbContextOptions<AppDbContext> Options(bool wal) => new DbContextOptionsBuilder<AppDbContext>()
                .UseSqlite($"Data Source={Path.Combine(dir, "t.db")}")
                .AddInterceptors(new SqlitePragmaInterceptor(wal))
                .Options;

            await using (var db = new AppDbContext(Options(true))) await db.Database.EnsureCreatedAsync();
            SqliteConnection.ClearAllPools();

            await using (var db = new AppDbContext(Options(false)))
            {
                var mode = await db.Database.SqlQueryRaw<string>("PRAGMA journal_mode").ToListAsync();
                Assert.Equal("delete", Assert.Single(mode));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
