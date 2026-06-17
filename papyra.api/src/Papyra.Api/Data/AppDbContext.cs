using Microsoft.EntityFrameworkCore;
using Papyra.Api.Models;

namespace Papyra.Api.Data;

// Relational cache (SQLite). Disposable — the filesystem is the source of truth.
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AppSetting> Settings => Set<AppSetting>();
    public DbSet<User> Users => Set<User>();
    public DbSet<NoteCache> NoteCache => Set<NoteCache>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AppSetting>().HasKey(s => s.Key);
        modelBuilder.Entity<NoteCache>().HasKey(n => n.Id);
        modelBuilder.Entity<User>().HasIndex(u => u.Username).IsUnique();
    }
}
