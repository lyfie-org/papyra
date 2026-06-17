using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class ConflictDetectorTests
{
    [Theory]
    [InlineData("note.sync-conflict-20240101-120000-ABCDEFG.md")] // Syncthing
    [InlineData("note (conflicted copy 2024-01-01).md")]          // Dropbox/Nextcloud
    [InlineData("note (rahul's conflicted copy 2024-01-01).md")]  // ownCloud
    public void IsConflict_RecognisesSyncCopies(string fileName) =>
        Assert.True(ConflictDetector.IsConflict(fileName));

    [Theory]
    [InlineData("note.md")]
    [InlineData("my-note.md")]
    public void IsConflict_IgnoresPlainNotes(string fileName) =>
        Assert.False(ConflictDetector.IsConflict(fileName));

    [Theory]
    [InlineData("note.sync-conflict-20240101-120000-ABCDEFG.md", "note.md")]
    [InlineData("note (conflicted copy 2024-01-01).md", "note.md")]
    public void ParentFileName_StripsTheConflictSuffix(string conflict, string expectedParent) =>
        Assert.Equal(expectedParent, ConflictDetector.ParentFileName(conflict));

    [Fact]
    public void ParentRelativePath_KeepsTheSharedSubdirectory()
    {
        var rel = Path.Combine("sub", "note.sync-conflict-20240101-120000-AB.md");
        Assert.Equal(Path.Combine("sub", "note.md"), ConflictDetector.ParentRelativePath(rel));
    }

    [Fact]
    public void EncodeId_IsRouteSafeAndStableAcrossSeparators()
    {
        var id = ConflictDetector.EncodeId("sub\\note (conflicted copy).md");
        Assert.DoesNotContain('/', id);
        Assert.DoesNotContain('+', id);
        Assert.Equal(ConflictDetector.EncodeId("sub/note (conflicted copy).md"), id);
    }
}
