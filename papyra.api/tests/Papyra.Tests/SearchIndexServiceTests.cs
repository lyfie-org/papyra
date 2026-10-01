using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class SearchIndexServiceTests
{
    private const string Uid = "u1";

    [Fact]
    public void IndexedNote_IsFoundByRareWord()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir);
        try
        {
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Groceries", Body = "buy zzyzxquux today" });

            var hits = svc.Search(Uid, "zzyzxquux");

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
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "First", Body = "uniquetoken" });
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Second", Body = "uniquetoken" });

            var hits = svc.Search(Uid, "uniquetoken");

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
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Keep", Body = "uniquetoken here" });
            svc.RemoveNote(Uid, "n1");

            Assert.Empty(svc.Search(Uid, "uniquetoken"));
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Search_IsFencedToTenant()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir);
        try
        {
            svc.IndexNote("alice", new Note { Id = "a1", Title = "Alice", Body = "sharedtoken" });
            svc.IndexNote("bob", new Note { Id = "b1", Title = "Bob", Body = "sharedtoken" });

            var alice = svc.Search("alice", "sharedtoken");
            var bob = svc.Search("bob", "sharedtoken");

            Assert.Equal("a1", Assert.Single(alice).Id); // only alice's note
            Assert.Equal("b1", Assert.Single(bob).Id);    // only bob's note
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    // Attachment text (OCR, transcripts) is folded into each referencing note's
    // own document — see MediaTextStore.
    private static Func<string, Note, string> Texts(Dictionary<string, string> byFile) =>
        (_, note) => string.Join('\n', byFile.Where(kv => (note.Body ?? "").Contains(kv.Key)).Select(kv => kv.Value));

    [Fact]
    public void OcrText_IsSearchable_AndResolvesToEveryNoteThatShowsThePicture()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir) { AttachmentText = Texts(new() { ["scan.png"] = "TOTAL DUE 42.00 invoicexyz" }) };
        try
        {
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Receipt", Body = "see ![[scan.png]]" });
            svc.IndexNote(Uid, new Note { Id = "n2", Title = "Taxes", Body = "also ![[scan.png|300]]" });
            svc.IndexNote(Uid, new Note { Id = "n3", Title = "Other", Body = "nothing" });

            var hits = svc.Search(Uid, "invoicexyz").Select(h => h.Id).OrderBy(x => x).ToList();
            Assert.Equal(["n1", "n2"], hits);
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void OcrText_SurvivesReindexAndRebuild_AndLeavesWithTheEmbed()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir) { AttachmentText = Texts(new() { ["scan.png"] = "ocronlytoken" }) };
        try
        {
            var note = new Note { Id = "n1", Title = "First", Body = "hello ![[scan.png]]" };
            svc.IndexNote(Uid, note);
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Edited", Body = "hello world ![[scan.png]]" });
            Assert.Equal("n1", Assert.Single(svc.Search(Uid, "ocronlytoken")).Id);

            // The nightly rebuild used to delete OCR documents for good.
            svc.RebuildUser(Uid, [note]);
            Assert.Equal("n1", Assert.Single(svc.Search(Uid, "ocronlytoken")).Id);

            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Edited", Body = "picture removed" });
            Assert.Empty(svc.Search(Uid, "ocronlytoken"));
        }
        finally
        {
            svc.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void OcrText_OfASecureNote_IsNeverSearchable()
    {
        var dir = NewTempDir();
        var svc = new SearchIndexService(dir) { AttachmentText = Texts(new() { ["passport.png"] = "passportnumberzz" }) };
        try
        {
            svc.IndexNote(Uid, new Note { Id = "s1", Title = "Documents", Body = "![[passport.png]]", Secure = true });
            Assert.Empty(svc.Search(Uid, "passportnumberzz"));

            // The same picture in an ordinary note is that note's to find.
            svc.IndexNote(Uid, new Note { Id = "n1", Title = "Trip", Body = "![[passport.png]]" });
            Assert.Equal("n1", Assert.Single(svc.Search(Uid, "passportnumberzz")).Id);
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
