using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class SearchIndexServiceTests
{
    [Fact]
    public void IndexedNote_IsFoundByRareWord()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir);
        try
        {
            svc.IndexNote(new Note { Id = "n1", Title = "Groceries", Body = "buy zzyzxquux today" });

            var hits = svc.Search("zzyzxquux");

            Assert.Single(hits);
            Assert.Equal("n1", hits[0].Id);
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Reindex_DoesNotDuplicate()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir);
        try
        {
            svc.IndexNote(new Note { Id = "n1", Title = "First", Body = "uniquetoken" });
            svc.IndexNote(new Note { Id = "n1", Title = "Second", Body = "uniquetoken" });

            var hits = svc.Search("uniquetoken");

            Assert.Single(hits); // update-by-id, not a second doc
            Assert.Equal("Second", hits[0].Title);
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void RemovedNote_DropsOutOfIndex()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir);
        try
        {
            svc.IndexNote(new Note { Id = "n1", Title = "Keep", Body = "uniquetoken here" });
            svc.RemoveNote("n1");

            Assert.Empty(svc.Search("uniquetoken"));
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-idx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
