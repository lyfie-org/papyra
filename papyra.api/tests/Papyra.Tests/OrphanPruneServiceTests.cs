using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// The nightly sweep that moves unreferenced attachments to the trash. It must
/// never take a file something still needs — a note (even a trashed one), an old
/// version of a note, a picture pasted into a note that hasn't saved yet — and
/// it must finish in time on a big vault.
/// </summary>
public sealed class OrphanPruneServiceTests : IDisposable
{
    private const string Uid = "1";
    private readonly string _data = Path.Combine(Path.GetTempPath(), "papyra-prune-" + Guid.NewGuid().ToString("N"));
    private readonly VaultState _state = new();
    private string Media => Path.Combine(_data, "users", Uid, "media");
    private string Notes => Path.Combine(_data, "users", Uid, "notes");
    private string MediaTrash => Path.Combine(_data, "users", Uid, ".trash", "media");
    private static readonly DateTime Old = DateTime.UtcNow.AddDays(-30);

    public OrphanPruneServiceTests() => Directory.CreateDirectory(Media);

    public void Dispose()
    {
        try { Directory.Delete(_data, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void MovesOldOrphans_KeepsReferencedAndFreshOnes()
    {
        MediaFile("used.png");
        MediaFile("orphan.png");
        MediaFile("just-pasted.png", DateTime.UtcNow); // its note hasn't saved yet
        Note("n1", "see ![[used.png|300]] here");

        var (moved, _) = Service().PruneOnce();

        Assert.Equal(1, moved);
        Assert.True(File.Exists(Path.Combine(Media, "used.png")));
        Assert.True(File.Exists(Path.Combine(Media, "just-pasted.png")));
        Assert.False(File.Exists(Path.Combine(Media, "orphan.png")));
        var day = Assert.Single(Directory.GetDirectories(MediaTrash));
        Assert.True(File.Exists(Path.Combine(day, "orphan.png"))); // moved, not deleted
    }

    [Fact]
    public void ReferencesMatchCaseInsensitively_AndInEveryForm()
    {
        MediaFile("photo.png");
        MediaFile("linked.jpg");
        MediaFile("doc.pdf");
        Note("n1", "![[Photo.PNG]] ![x](/api/media/linked.jpg) [[doc.pdf#page=2]]");

        Assert.Equal(0, Service().PruneOnce().Moved);
    }

    [Fact]
    public void AFileOnlyAnOldVersionMentions_IsKept_SoRestoringItBringsThePictureBack()
    {
        MediaFile("from-history.png");
        Note("n1", "the picture was removed from this note");
        var snapshots = Path.Combine(_data, "users", Uid, ".papyra", "snapshots", "n1");
        Directory.CreateDirectory(snapshots);
        File.WriteAllText(Path.Combine(snapshots, "638000000000000000.md"), "---\nid: n1\n---\n![[from-history.png]]");

        Assert.Equal(0, Service().PruneOnce().Moved);
    }

    [Fact]
    public void ATrashedNotesPictures_AreKept()
    {
        MediaFile("in-trash.png");
        Note("n1", "![[in-trash.png]]", trashed: true);

        Assert.Equal(0, Service().PruneOnce().Moved);
    }

    [Fact]
    public void StaleUploadTemps_AreRemoved_ButNotOnesInFlight()
    {
        var stale = MediaFile("aaa.tmp", DateTime.UtcNow.AddHours(-2));
        var fresh = MediaFile("bbb.tmp", DateTime.UtcNow);
        Note("n", "");

        Assert.Equal(0, Service().PruneOnce().Moved);
        Assert.False(File.Exists(stale));
        Assert.True(File.Exists(fresh));
    }

    [Fact]
    public void TrashedMedia_IsPurgedAfterRetention_AndKeptForeverOnMinusOne()
    {
        Note("n", "");
        var expired = Path.Combine(MediaTrash, DateTime.UtcNow.AddDays(-40).ToString("yyyyMMdd"));
        var recent = Path.Combine(MediaTrash, DateTime.UtcNow.AddDays(-2).ToString("yyyyMMdd"));
        Directory.CreateDirectory(expired);
        Directory.CreateDirectory(recent);
        File.WriteAllText(Path.Combine(expired, "gone.png"), "x");
        File.WriteAllText(Path.Combine(recent, "kept.png"), "x");

        Assert.Equal(0, Service().PruneOnce(retentionDays: -1).Purged);
        Assert.True(Directory.Exists(expired));

        Assert.Equal(1, Service().PruneOnce(retentionDays: 30).Purged);
        Assert.False(Directory.Exists(expired));
        Assert.True(File.Exists(Path.Combine(recent, "kept.png")));
    }

    [Fact]
    public void DerivedState_TravelsWithThePrunedFile_AndUnusedThumbnailsGo()
    {
        MediaFile("orphan.png");
        MediaFile("kept.png");
        Note("n1", "![[kept.png]]");
        var derived = Path.Combine(_data, "users", Uid, ".papyra", "media");
        Directory.CreateDirectory(Path.Combine(derived, "thumbs"));
        File.WriteAllText(Path.Combine(derived, "orphan.png.meta.json"), "{\"version\":\"aaaa\"}");
        File.WriteAllText(Path.Combine(derived, "orphan.png.poster.webp"), "p");
        File.WriteAllText(Path.Combine(derived, "kept.png.meta.json"), "{\"version\":\"bbbb\"}");
        File.WriteAllText(Path.Combine(derived, "thumbs", "aaaa-320.webp"), "t");
        File.WriteAllText(Path.Combine(derived, "thumbs", "bbbb-320.webp"), "t");

        Service().PruneOnce();

        var day = Assert.Single(Directory.GetDirectories(MediaTrash));
        Assert.True(File.Exists(Path.Combine(day, "orphan.png.meta.json")));
        Assert.True(File.Exists(Path.Combine(day, "orphan.png.poster.webp")));
        Assert.False(File.Exists(Path.Combine(derived, "thumbs", "aaaa-320.webp")));
        Assert.True(File.Exists(Path.Combine(derived, "thumbs", "bbbb-320.webp")));
    }

    [Fact]
    public void ABigVault_SweepsInLinearTime()
    {
        const int notes = 10_000, files = 5_000;
        for (var i = 0; i < files; i++) MediaFile($"file-{i:D5}.png");
        for (var i = 0; i < notes; i++)
            Note($"n{i}", $"note {i} with some words and ![[file-{i % files:D5}.png]] and more words after it");

        var watch = Stopwatch.StartNew();
        var (moved, _) = Service().PruneOnce();
        watch.Stop();

        Assert.Equal(0, moved);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"sweep took {watch.Elapsed}");
    }

    private string MediaFile(string name, DateTime? touched = null)
    {
        var path = Path.Combine(Media, name);
        File.WriteAllText(path, "x");
        var when = touched ?? Old;
        File.SetCreationTimeUtc(path, when);
        File.SetLastWriteTimeUtc(path, when);
        return path;
    }

    private void Note(string id, string body, bool trashed = false) =>
        _state.Upsert(Uid, Path.Combine(Notes, id + ".md"), new Note { Id = id, Body = body, Trashed = trashed });

    private OrphanPruneService Service()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = _data })
            .Build();
        var env = new StubEnv();
        return new OrphanPruneService(
            _state,
            new MediaReferences(_state, config, env),
            new MediaMetaStore(config, env, new MemoryCache(new MemoryCacheOptions()), NullLogger<MediaMetaStore>.Instance),
            config, env,
            new JobRegistry(NullLogger<JobRegistry>.Instance), NullLogger<OrphanPruneService>.Instance);
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
