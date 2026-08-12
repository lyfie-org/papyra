using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// The dangling-grant sweep. The interesting cases are all about restraint: the
// sweeper judges a grant dead from VaultState, and VaultState is a mirror that
// fills in after boot, so being wrong here deletes live authorisations.
public sealed class GrantCleanupTests
{
    private const string OwnerUid = "1";
    private const int OwnerId = 1;
    private const int GranteeId = 2;

    private static (GrantCleanupService Svc, ServiceProvider Sp, SqliteConnection Conn) NewService(VaultState state)
    {
        var conn = new SqliteConnection("DataSource=:memory:");
        conn.Open();

        var services = new ServiceCollection();
        services.AddDbContext<AppDbContext>(o => o.UseSqlite(conn));
        var sp = services.BuildServiceProvider();

        using (var scope = sp.CreateScope())
            scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();

        var svc = new GrantCleanupService(
            sp.GetRequiredService<IServiceScopeFactory>(), state, NullLogger<GrantCleanupService>.Instance);
        return (svc, sp, conn);
    }

    private static BlockGrant Grant(string noteId, string blockId) => new()
    {
        SourceOwnerId = OwnerId,
        SourceNoteId = noteId,
        BlockId = blockId,
        GranteeUserId = GranteeId,
        SourceUsername = "ana",
        CreatedUtc = DateTime.UtcNow,
    };

    private static void Seed(ServiceProvider sp, params BlockGrant[] grants)
    {
        using var scope = sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.BlockGrants.AddRange(grants);
        db.SaveChanges();
    }

    private static async Task<string[]> RemainingBlockIds(ServiceProvider sp)
    {
        using var scope = sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.BlockGrants.Select(g => g.BlockId).OrderBy(x => x).ToArrayAsync();
    }

    [Fact]
    public async Task AnEmptyVaultIsNeverSwept_BecauseItMightJustBeUnloaded()
    {
        // This is the whole hazard: at boot every bucket is empty, and treating
        // that as "the note is gone" would delete every grant on the instance.
        var state = new VaultState();   // nothing mirrored yet
        var (svc, sp, conn) = NewService(state);
        try
        {
            Seed(sp, Grant("standup", "ping0001"));
            Assert.Equal(0, await svc.CleanupOnceAsync(default));
            Assert.Equal(["ping0001"], await RemainingBlockIds(sp));
        }
        finally { sp.Dispose(); conn.Close(); }
    }

    [Fact]
    public async Task AGrantWhoseNoteIsGoneIsRemoved()
    {
        var state = new VaultState();
        // The vault is populated — just not with the note the grant points at.
        state.Upsert(OwnerUid, "/vault/other.md", new Note { Id = "other", Body = "unrelated ^zzz00001" });

        var (svc, sp, conn) = NewService(state);
        try
        {
            Seed(sp, Grant("deleted-note", "ping0001"));
            Assert.Equal(1, await svc.CleanupOnceAsync(default));
            Assert.Empty(await RemainingBlockIds(sp));
        }
        finally { sp.Dispose(); conn.Close(); }
    }

    [Fact]
    public async Task AGrantWhoseAnchorIsGoneIsRemoved_ButItsLiveSiblingSurvives()
    {
        var state = new VaultState();
        state.Upsert(OwnerUid, "/vault/standup.md", new Note
        {
            Id = "standup",
            Body = "Still here. ^alive001",   // ^gone0001 was deleted from the note
        });

        var (svc, sp, conn) = NewService(state);
        try
        {
            Seed(sp, Grant("standup", "alive001"), Grant("standup", "gone0001"));
            Assert.Equal(1, await svc.CleanupOnceAsync(default));
            Assert.Equal(["alive001"], await RemainingBlockIds(sp));
        }
        finally { sp.Dispose(); conn.Close(); }
    }

    [Fact]
    public async Task ASecureNoteKeepsItsGrants()
    {
        var state = new VaultState();
        // A secure note withholds its body everywhere, so a missing anchor here is
        // evidence of nothing — treating it as dead would revoke a live grant the
        // moment someone locked their note.
        state.Upsert(OwnerUid, "/vault/secret.md", new Note
        {
            Id = "secret",
            Secure = true,
            Body = string.Empty,
        });

        var (svc, sp, conn) = NewService(state);
        try
        {
            Seed(sp, Grant("secret", "ping0001"));
            Assert.Equal(0, await svc.CleanupOnceAsync(default));
            Assert.Equal(["ping0001"], await RemainingBlockIds(sp));
        }
        finally { sp.Dispose(); conn.Close(); }
    }

    [Fact]
    public async Task ALiveGrantIsLeftAlone()
    {
        var state = new VaultState();
        state.Upsert(OwnerUid, "/vault/standup.md", new Note
        {
            Id = "standup",
            Body = "Can @bea take this? ^ping0001",
        });

        var (svc, sp, conn) = NewService(state);
        try
        {
            Seed(sp, Grant("standup", "ping0001"));
            Assert.Equal(0, await svc.CleanupOnceAsync(default));
            Assert.Equal(["ping0001"], await RemainingBlockIds(sp));
        }
        finally { sp.Dispose(); conn.Close(); }
    }

    [Fact]
    public async Task NoGrantsIsANoOp()
    {
        var (svc, sp, conn) = NewService(new VaultState());
        try { Assert.Equal(0, await svc.CleanupOnceAsync(default)); }
        finally { sp.Dispose(); conn.Close(); }
    }
}
