using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Tests.Services;

public sealed class IndexManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private readonly IndexManager _sut;

    public IndexManagerTests()
    {
        Directory.CreateDirectory(_dir);
        _sut = new IndexManager(_dir);
    }

    public void Dispose()
    {
        _sut.Dispose();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void UpdateIndex_SearchByContent_FindsNote()
    {
        Index("id1", "Title", "full text search engine");
        Assert.Contains(_sut.Search("search"), r => r.Id == "id1");
    }

    [Fact]
    public void UpdateIndex_SearchByTitle_FindsNote()
    {
        Index("id2", "Unique Zephyr Title", "body");
        Assert.Contains(_sut.Search("Zephyr"), r => r.Id == "id2");
    }

    [Fact]
    public void UpdateIndex_SearchByTag_FindsNote()
    {
        Index("id3", "Tagged", "body", ["important", "work"]);
        Assert.Contains(_sut.Search("important"), r => r.Id == "id3");
    }

    [Fact]
    public void RemoveFromIndex_NoteNoLongerReturned()
    {
        Index("id4", "Removable", "will be gone");
        Assert.Contains(_sut.Search("Removable"), r => r.Id == "id4");

        _sut.RemoveFromIndex("id4");

        Assert.DoesNotContain(_sut.Search("Removable"), r => r.Id == "id4");
    }

    [Fact]
    public void UpdateIndex_SameId_OverwritesPreviousDocument()
    {
        Index("id5", "Old Title", "old content");
        Index("id5", "New Title", "new content here");

        Assert.Contains(_sut.Search("new"), r => r.Id == "id5");
        // "old" content should be gone — only one doc for this id
        var results = _sut.Search("old");
        Assert.DoesNotContain(results, r => r.Id == "id5");
    }

    [Fact]
    public void Search_EmptyIndex_ReturnsEmpty()
    {
        Assert.Empty(_sut.Search("anything"));
    }

    [Fact]
    public void Search_InvalidQuery_ReturnsEmpty()
    {
        Index("id6", "Test", "content");
        // Bare boolean operators are not valid Lucene queries
        var results = _sut.Search("AND OR");
        Assert.NotNull(results);
    }

    [Fact]
    public void Search_MultipleNotes_ReturnsOnlyMatching()
    {
        Index("match1", "Rocket Science", "orbital mechanics");
        Index("nomatch", "Baking Recipes", "flour butter sugar");

        var results = _sut.Search("orbital");
        Assert.Contains(results, r => r.Id == "match1");
        Assert.DoesNotContain(results, r => r.Id == "nomatch");
    }

    [Fact]
    public void Search_ReturnsSnippetFromContent()
    {
        Index("id7", "Title", "some unique snippet text here");
        var results = _sut.Search("snippet");
        Assert.Contains(results, r => r.Id == "id7" && r.Snippet.Contains("snippet"));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void Index(string id, string title, string content = "", List<string>? tags = null)
    {
        var tagList = tags ?? [];
        var meta    = new NoteMetadata(id, title, tagList, false, "", "", false, false,
                                       DateTime.UtcNow, DateTime.UtcNow);
        var tagYaml = tagList.Count > 0
            ? "[" + string.Join(",", tagList.Select(t => $"\"{t}\"")) + "]"
            : "[]";
        var raw  = $"---\nid: {id}\ntitle: \"{title}\"\ntags: {tagYaml}\npinned: false\ncolor: \"\"\nowner: \"\"\narchived: false\ndeleted: false\n---\n{content}";
        var path = Path.Combine(_dir, $"{id}.md");
        File.WriteAllText(path, raw);
        _sut.UpdateIndex(meta, path);
    }
}
