using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class ShareCleanupServiceTests
{
    [Fact]
    public async Task Cleanup_RemovesExpiredAndExhausted_KeepsLiveShares()
    {
        // One shared in-memory DB across scopes: keep the connection open for its life.
        var conn = new SqliteConnection("DataSource=:memory:");
        conn.Open();
        try
        {
            var services = new ServiceCollection();
            services.AddDbContext<AppDbContext>(o => o.UseSqlite(conn));
            var sp = services.BuildServiceProvider();

            using (var scope = sp.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                db.Database.EnsureCreated();
                db.Shares.AddRange(
                    new Share { NoteId = "n1", OwnerId = 1, Kind = "link", Token = "expired",
                        ExpiresUtc = DateTime.UtcNow.AddMinutes(-5) },                       // past expiry → gone
                    new Share { NoteId = "n2", OwnerId = 1, Kind = "link", Token = "burned",
                        MaxViews = 1, ViewCount = 1 },                                        // view cap hit → gone
                    new Share { NoteId = "n3", OwnerId = 1, Kind = "link", Token = "live",
                        ExpiresUtc = DateTime.UtcNow.AddDays(1), MaxViews = 5, ViewCount = 2 },// still valid → kept
                    new Share { NoteId = "n4", OwnerId = 1, Kind = "user", GranteeUserId = 2 }); // no limits → kept
                await db.SaveChangesAsync();
            }

            var svc = new ShareCleanupService(
                sp.GetRequiredService<IServiceScopeFactory>(),
                NullLogger<ShareCleanupService>.Instance);

            var removed = await svc.CleanupOnceAsync(default);
            Assert.Equal(2, removed);

            using (var scope = sp.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var tokens = await db.Shares.Select(s => s.NoteId).OrderBy(x => x).ToListAsync();
                Assert.Equal(["n3", "n4"], tokens);
            }
        }
        finally
        {
            conn.Close();
        }
    }
}
