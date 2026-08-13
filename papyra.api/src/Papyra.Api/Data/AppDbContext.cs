using Microsoft.EntityFrameworkCore;
using Papyra.Api.Models;

namespace Papyra.Api.Data;

// Relational cache (SQLite). Disposable — the filesystem is the source of truth.
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AppSetting> Settings => Set<AppSetting>();
    public DbSet<User> Users => Set<User>();
    public DbSet<NoteCache> NoteCache => Set<NoteCache>();
    public DbSet<ApiKey> ApiKeys => Set<ApiKey>();
    public DbSet<Share> Shares => Set<Share>();
    public DbSet<Webhook> Webhooks => Set<Webhook>();
    public DbSet<SmartCollection> SmartCollections => Set<SmartCollection>();
    public DbSet<WebAuthnCredential> WebAuthnCredentials => Set<WebAuthnCredential>();
    public DbSet<NoteEmbedding> NoteEmbeddings => Set<NoteEmbedding>();
    public DbSet<BlockGrant> BlockGrants => Set<BlockGrant>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AppSetting>().HasKey(s => s.Key);
        // Composite: a note id is unique per vault, not per instance. See NoteCache.
        modelBuilder.Entity<NoteCache>().HasKey(n => new { n.UserId, n.Id });
        modelBuilder.Entity<User>().HasIndex(u => u.Username).IsUnique();
        // Unique per IdP subject; SQLite treats NULLs as distinct, so local
        // (non-SSO) accounts with a null ExternalId don't collide.
        modelBuilder.Entity<User>().HasIndex(u => u.ExternalId).IsUnique();
        modelBuilder.Entity<ApiKey>().HasIndex(k => k.TokenHash).IsUnique();
        modelBuilder.Entity<ApiKey>().HasIndex(k => k.UserId);
        modelBuilder.Entity<Share>().HasIndex(s => s.Token);
        modelBuilder.Entity<Share>().HasIndex(s => s.NoteId);
        modelBuilder.Entity<Share>().HasIndex(s => s.GranteeUserId);
        modelBuilder.Entity<Webhook>().HasIndex(w => new { w.UserId, w.TriggerEvent });
        modelBuilder.Entity<SmartCollection>().HasIndex(c => c.UserId);
        modelBuilder.Entity<WebAuthnCredential>().HasIndex(c => c.CredentialId).IsUnique();
        modelBuilder.Entity<WebAuthnCredential>().HasIndex(c => c.UserId);
        modelBuilder.Entity<NoteEmbedding>().HasIndex(e => new { e.UserId, e.NoteId });
        // One grant per (block, recipient): re-saving a note that still mentions
        // the same person must not stack duplicate inbox entries.
        modelBuilder.Entity<BlockGrant>()
            .HasIndex(g => new { g.SourceOwnerId, g.SourceNoteId, g.BlockId, g.GranteeUserId })
            .IsUnique();
        modelBuilder.Entity<BlockGrant>().HasIndex(g => g.GranteeUserId);
    }
}
