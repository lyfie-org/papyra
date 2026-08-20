using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class OrphanPruneServiceTests
{
    [Fact]
    public void Prune_MovesUnreferencedMedia_KeepsReferenced()
    {
        const string uid = "1";
        var dataDir = NewTempDir();
        var mediaDir = Path.Combine(dataDir, "users", uid, "media");
        var trashDir = Path.Combine(dataDir, "users", uid, ".trash");
        Directory.CreateDirectory(mediaDir);

        File.WriteAllText(Path.Combine(mediaDir, "used.png"), "x");
        File.WriteAllText(Path.Combine(mediaDir, "orphan.png"), "y");

        var state = new VaultState();
        state.Upsert(uid, Path.Combine(mediaDir, "..", "notes", "n.md"),
            new Note { Id = "n1", Body = "see ![[used.png]] here" });

        try
        {
            var moved = NewService(dataDir, state).PruneOnce();

            Assert.Equal(1, moved);
            Assert.True(File.Exists(Path.Combine(mediaDir, "used.png")));   // referenced kept
            Assert.False(File.Exists(Path.Combine(mediaDir, "orphan.png"))); // orphan gone
            Assert.True(File.Exists(Path.Combine(trashDir, "orphan.png")));  // moved, not deleted
        }
        finally
        {
            if (Directory.Exists(dataDir)) Directory.Delete(dataDir, recursive: true);
        }
    }

    private static OrphanPruneService NewService(string dataDir, VaultState state)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dataDir })
            .Build();
        return new OrphanPruneService(
            state, config, new StubEnv(),
            new JobRegistry(NullLogger<JobRegistry>.Instance), NullLogger<OrphanPruneService>.Instance);
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-prune-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    // DataDir is resolved from config "Papyra:DataDir", so ContentRootPath is unused.
    private sealed class StubEnv : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Papyra.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
