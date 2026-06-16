using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class MarkdownStorageServiceTests
{
    private readonly MarkdownStorageService _svc = new();

    [Fact]
    public void RoundTrip_PreservesKnownFields()
    {
        var note = new Note
        {
            Id = "abc123",
            Title = "Grocery list",
            Tags = ["food", "errands"],
            Color = "#7aaa8a",
            Pinned = true,
            Body = "- milk\n- eggs\n",
        };

        var back = _svc.Deserialize(_svc.Serialize(note));

        Assert.Equal(note.Id, back.Id);
        Assert.Equal(note.Title, back.Title);
        Assert.Equal(note.Tags, back.Tags);
        Assert.Equal(note.Color, back.Color);
        Assert.True(back.Pinned);
        Assert.Equal(note.Body.TrimEnd(), back.Body.TrimEnd());
    }

    [Fact]
    public void Deserialize_UnknownYamlKeys_DoNotCrash()
    {
        var doc = "---\ntitle: Foo\nobsidianWeirdKey: 42\nsyncthing: yes\n---\n\nbody";

        var note = _svc.Deserialize(doc);

        Assert.Equal("Foo", note.Title);
        Assert.Equal("body", note.Body.TrimEnd());
    }

    [Fact]
    public void Deserialize_NoFrontmatter_TreatsAllAsBody()
    {
        var note = _svc.Deserialize("just some text\nno yaml");

        Assert.Equal(string.Empty, note.Title);
        Assert.Contains("just some text", note.Body);
    }

    [Fact]
    public async Task WriteAsync_WritesThroughToDisk()
    {
        var dir = NewTempDir();
        try
        {
            var path = Path.Combine(dir, "note.md");
            var note = new Note { Id = "n1", Title = "Hello", Body = "world" };

            await _svc.WriteAsync(path, note);

            Assert.True(File.Exists(path));
            Assert.True(new FileInfo(path).Length > 0); // never a 0-byte .md
            var reread = await _svc.ReadAsync(path);
            Assert.Equal("Hello", reread!.Title);
            Assert.Equal("world", reread.Body.TrimEnd());

            // No stray .tmp left behind.
            Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task WriteAsync_PreservesForeignFrontmatter_OnUpdate()
    {
        var dir = NewTempDir();
        try
        {
            var path = Path.Combine(dir, "note.md");
            await File.WriteAllTextAsync(path,
                "---\ntitle: Old\ncustomKey: keepme\n---\n\noriginal");

            await _svc.WriteAsync(path, new Note { Id = "n1", Title = "New", Body = "updated" });

            var raw = await File.ReadAllTextAsync(path);
            Assert.Contains("customKey: keepme", raw); // foreign key survived
            Assert.Contains("title: New", raw);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}
