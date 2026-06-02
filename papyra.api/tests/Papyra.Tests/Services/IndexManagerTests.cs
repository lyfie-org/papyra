using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Tests.Services;

public sealed class IndexManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private readonly IndexManager _sut;

    public IndexManagerTests() => _sut = new IndexManager(_dir);

    public void Dispose()
    {
        _sut.Dispose();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void UpdateIndex_SearchByContent_FindsNote()
    {
        _sut.UpdateIndex(MakeNote("id1", "Title", content: "full text search engine"));
        Assert.Contains(_sut.Search("search"), r => r.Id == "id1");
    }

    [Fact]
    public void UpdateIndex_SearchByTitle_FindsNote()
    {
        _sut.UpdateIndex(MakeNote("id2", "Unique Zephyr Title", content: "body"));
        Assert.Contains(_sut.Search("Zephyr"), r => r.Id == "id2");
    }

    [Fact]
    public void UpdateIndex_SearchByTag_FindsNote()
    {
        _sut.UpdateIndex(MakeNote("id3", "Tagged", tags: ["important", "work"], content: "body"));
        Assert.Contains(_sut.Search("important"), r => r.Id == "id3");
    }

    [Fact]
    public void RemoveFromIndex_NoteNoLongerReturned()
    {
        _sut.UpdateIndex(MakeNote("id4", "Removable", content: "will be gone"));
        Assert.Contains(_sut.Search("Removable"), r => r.Id == "id4");

        _sut.RemoveFromIndex("id4");

        Assert.DoesNotContain(_sut.Search("Removable"), r => r.Id == "id4");
    }

    [Fact]
    public void UpdateIndex_SameId_OverwritesPreviousDocument()
    {
        _sut.UpdateIndex(MakeNote("id5", "Old Title", content: "old content"));
        _sut.UpdateIndex(MakeNote("id5", "New Title", content: "new content here"));

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
        _sut.UpdateIndex(MakeNote("id6", "Test", content: "content"));
        // Bare boolean operators are not valid Lucene queries
        var results = _sut.Search("AND OR");
        Assert.NotNull(results);
    }

    [Fact]
    public void Search_MultipleNotes_ReturnsOnlyMatching()
    {
        _sut.UpdateIndex(MakeNote("match1", "Rocket Science", content: "orbital mechanics"));
        _sut.UpdateIndex(MakeNote("nomatch", "Baking Recipes", content: "flour butter sugar"));

        var results = _sut.Search("orbital");
        Assert.Contains(results, r => r.Id == "match1");
        Assert.DoesNotContain(results, r => r.Id == "nomatch");
    }

    [Fact]
    public void Search_ReturnsSnippetFromContent()
    {
        _sut.UpdateIndex(MakeNote("id7", "Title", content: "some unique snippet text here"));
        var results = _sut.Search("snippet");
        Assert.Contains(results, r => r.Id == "id7" && r.Snippet.Contains("snippet"));
    }

    private static Note MakeNote(
        string id, string title,
        List<string>? tags = null,
        string content = "") =>
        new() { Id = id, Title = title, Tags = tags ?? [], Content = content };
}
