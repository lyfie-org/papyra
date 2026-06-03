using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Tests.Services;

public sealed class MarkdownStorageServiceTests
{
    private readonly MarkdownStorageService _sut = new();

    // ── Serialization ────────────────────────────────────────────────────────

    [Fact]
    public void SerializeNote_ProducesOpeningAndClosingFrontmatterDelimiters()
    {
        var result = _sut.SerializeNote(MakeNote());
        Assert.StartsWith("---\n", result);
        Assert.Contains("\n---\n", result["---\n".Length..]);
    }

    [Fact]
    public void SerializeNote_ContainsAllFields()
    {
        var note = MakeNote(id: "abc", title: "My Note", color: "#ffcc00", pinned: true,
            tags: ["work", "test"], content: "Hello");
        var result = _sut.SerializeNote(note);
        Assert.Contains("id: abc", result);
        Assert.Contains("title: \"My Note\"", result);
        Assert.Contains("color: \"#ffcc00\"", result);
        Assert.Contains("pinned: true", result);
        Assert.Contains("\"work\"", result);
        Assert.Contains("\"test\"", result);
        Assert.Contains("Hello", result);
    }

    [Fact]
    public void SerializeNote_EmptyTagsProducesEmptyArray()
    {
        var result = _sut.SerializeNote(MakeNote(tags: []));
        Assert.Contains("tags: []", result);
    }

    [Fact]
    public void SerializeNote_PinnedFalse_WrittenAsLowercase()
    {
        var result = _sut.SerializeNote(MakeNote(pinned: false));
        Assert.Contains("pinned: false", result);
    }

    [Fact]
    public void SerializeNote_PinnedTrue_WrittenAsLowercase()
    {
        var result = _sut.SerializeNote(MakeNote(pinned: true));
        Assert.Contains("pinned: true", result);
    }

    [Fact]
    public void SerializeNote_ContentAppearsVerbatimAfterClosingDelimiter()
    {
        var note = MakeNote(content: "# Hello\nWorld");
        var result = _sut.SerializeNote(note);
        var delimIdx = result.IndexOf("\n---\n");
        var afterDelim = result[(delimIdx + "\n---\n".Length)..];
        Assert.Equal("# Hello\nWorld", afterDelim);
    }

    [Fact]
    public void SerializeNote_HexColorQuoted()
    {
        var result = _sut.SerializeNote(MakeNote(color: "#ffa500"));
        Assert.Contains("color: \"#ffa500\"", result);
    }

    // ── Deserialization ───────────────────────────────────────────────────────

    [Fact]
    public void DeserializeNote_ParsesAllFields()
    {
        const string raw =
            "---\nid: abc\ntitle: \"My Note\"\ntags: [\"work\",\"test\"]\npinned: true\ncolor: \"#ffcc00\"\n---\n# Hello\nWorld";
        var note = _sut.DeserializeNote(raw);
        Assert.Equal("abc", note.Id);
        Assert.Equal("My Note", note.Title);
        Assert.Equal(["work", "test"], note.Tags);
        Assert.True(note.Pinned);
        Assert.Equal("#ffcc00", note.Color);
        Assert.Equal("# Hello\nWorld", note.Content);
    }

    [Fact]
    public void DeserializeNote_EmptyTagsYieldsEmptyList()
    {
        var note = _sut.DeserializeNote(MinimalRaw(tags: "[]"));
        Assert.Empty(note.Tags);
    }

    [Fact]
    public void DeserializeNote_SingleTag_ParsedCorrectly()
    {
        var note = _sut.DeserializeNote(MinimalRaw(tags: "[\"solo\"]"));
        Assert.Equal(["solo"], note.Tags);
    }

    [Fact]
    public void DeserializeNote_MultipleTagsWithSpaces_ParsedCorrectly()
    {
        var note = _sut.DeserializeNote(MinimalRaw(tags: "[\"work\", \"meeting\", \"urgent\"]"));
        Assert.Equal(["work", "meeting", "urgent"], note.Tags);
    }

    [Fact]
    public void DeserializeNote_PinnedTrue_Parsed()
    {
        var note = _sut.DeserializeNote(MinimalRaw(pinned: "true"));
        Assert.True(note.Pinned);
    }

    [Fact]
    public void DeserializeNote_PinnedFalse_Parsed()
    {
        var note = _sut.DeserializeNote(MinimalRaw(pinned: "false"));
        Assert.False(note.Pinned);
    }

    [Fact]
    public void DeserializeNote_HexColorPreservesHash()
    {
        var note = _sut.DeserializeNote(MinimalRaw(color: "\"#ffa500\""));
        Assert.Equal("#ffa500", note.Color);
    }

    [Fact]
    public void DeserializeNote_EmptyContent_YieldsEmptyString()
    {
        var note = _sut.DeserializeNote(MinimalRaw());
        Assert.Equal(string.Empty, note.Content);
    }

    [Fact]
    public void DeserializeNote_MultiLineContent_PreservesStructure()
    {
        const string raw =
            "---\nid: x\ntitle: \"T\"\ntags: []\npinned: false\ncolor: \"\"\n---\n# H1\n\nParagraph one.\n\nParagraph two.";
        var note = _sut.DeserializeNote(raw);
        Assert.Equal("# H1\n\nParagraph one.\n\nParagraph two.", note.Content);
    }

    [Fact]
    public void DeserializeNote_CrLfLineEndings_NormalizedCorrectly()
    {
        var raw = "---\r\nid: abc\r\ntitle: \"T\"\r\ntags: []\r\npinned: false\r\ncolor: \"\"\r\n---\r\nContent";
        var note = _sut.DeserializeNote(raw);
        Assert.Equal("abc", note.Id);
        Assert.Equal("Content", note.Content);
    }

    // ── Timestamps ───────────────────────────────────────────────────────────

    [Fact]
    public void SerializeNote_ContainsTimestampFields()
    {
        var ts = new DateTime(2026, 6, 2, 12, 0, 0, DateTimeKind.Utc);
        var note = MakeNote(createdAt: ts, updatedAt: ts);
        var result = _sut.SerializeNote(note);
        Assert.Contains("created_at:", result);
        Assert.Contains("updated_at:", result);
    }

    [Fact]
    public void DeserializeNote_ParsesTimestamps()
    {
        var ts = new DateTime(2026, 6, 2, 12, 0, 0, DateTimeKind.Utc);
        var note = MakeNote(createdAt: ts, updatedAt: ts.AddHours(1));
        var serialized = _sut.SerializeNote(note);
        var result = _sut.DeserializeNote(serialized);
        Assert.Equal(ts, result.CreatedAt);
        Assert.Equal(ts.AddHours(1), result.UpdatedAt);
    }

    [Fact]
    public void DeserializeNote_MissingTimestamps_DefaultsToUtcNow()
    {
        const string raw = "---\nid: x\ntitle: \"T\"\ntags: []\npinned: false\ncolor: \"\"\n---\n";
        var before = DateTime.UtcNow.AddSeconds(-1);
        var note = _sut.DeserializeNote(raw);
        Assert.True(note.CreatedAt >= before);
        Assert.True(note.UpdatedAt >= before);
    }

    // ── Round-trip ────────────────────────────────────────────────────────────

    [Theory]
    [MemberData(nameof(RoundTripCases))]
    public void RoundTrip_SerializeThenDeserialize_YieldsSameNote(Note original)
    {
        var serialized = _sut.SerializeNote(original);
        var deserialized = _sut.DeserializeNote(serialized);

        Assert.Equal(original.Id, deserialized.Id);
        Assert.Equal(original.Title, deserialized.Title);
        Assert.Equal(original.Tags, deserialized.Tags);
        Assert.Equal(original.Pinned, deserialized.Pinned);
        Assert.Equal(original.Color, deserialized.Color);
        Assert.Equal(original.Content, deserialized.Content);
        Assert.Equal(original.CreatedAt, deserialized.CreatedAt);
        Assert.Equal(original.UpdatedAt, deserialized.UpdatedAt);
    }

    private static readonly DateTime _t1 = new(2026, 3, 15, 10, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime _t2 = new(2026, 5, 20, 18, 30, 0, DateTimeKind.Utc);

    public static TheoryData<Note> RoundTripCases => new()
    {
        MakeNote(id: "a1b2", title: "Basic Note", tags: ["work"], pinned: false,
            color: "#ffffff", content: "Hello world", createdAt: _t1, updatedAt: _t2),
        MakeNote(id: "z9y8", title: "Pinned Note", tags: ["important"], pinned: true,
            color: "#ff0000", content: "Stay on top", createdAt: _t1, updatedAt: _t1),
        MakeNote(id: "empty", title: "No Tags No Content", tags: [], pinned: false,
            color: "#000000", content: "", createdAt: _t2, updatedAt: _t2),
        MakeNote(id: "multi", title: "Many Tags", tags: ["a", "b", "c"], pinned: false,
            color: "#abc123", content: "# Heading\n\nParagraph.", createdAt: _t1, updatedAt: _t2),
        MakeNote(id: "hex", title: "Orange Note", tags: [], pinned: true,
            color: "#ffa500", content: "Warm colour", createdAt: _t2, updatedAt: _t2),
        MakeNote(id: "multiline", title: "Long Content", tags: ["docs"], pinned: false,
            color: "#cccccc", content: "Line 1\nLine 2\nLine 3", createdAt: _t1, updatedAt: _t1),
    };

    // ── Error cases ───────────────────────────────────────────────────────────

    [Fact]
    public void DeserializeNote_MissingOpeningDelimiter_ThrowsFormatException()
    {
        Assert.Throws<FormatException>(() => _sut.DeserializeNote("no frontmatter here"));
    }

    [Fact]
    public void DeserializeNote_MissingClosingDelimiter_ThrowsFormatException()
    {
        Assert.Throws<FormatException>(() => _sut.DeserializeNote("---\nid: x\ntitle: \"T\""));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static Note MakeNote(
        string id = "test-id",
        string title = "Test Note",
        List<string>? tags = null,
        bool pinned = false,
        string color = "#ffffff",
        string content = "",
        DateTime? createdAt = null,
        DateTime? updatedAt = null)
    {
        var now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        return new()
        {
            Id        = id,
            Title     = title,
            Tags      = tags ?? [],
            Pinned    = pinned,
            Color     = color,
            Content   = content,
            CreatedAt = createdAt ?? now,
            UpdatedAt = updatedAt ?? now,
        };
    }

    // ── ParseFrontmatterOnly ────────────────────────────────────────────────────

    [Fact]
    public void ParseFrontmatterOnly_ReadsAllMetadataFields()
    {
        var ts  = new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        var raw = $"---\nid: meta-1\ntitle: \"Metadata Note\"\ntags: [\"a\",\"b\"]\npinned: true\ncolor: \"#abc\"\nowner: alice\narchived: false\ndeleted: false\ncreated_at: {ts:O}\nupdated_at: {ts:O}\n---\nBody text that must NOT be read.\n";
        using var ms = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(raw));
        var meta = _sut.ParseFrontmatterOnly(ms);

        Assert.Equal("meta-1", meta.Id);
        Assert.Equal("Metadata Note", meta.Title);
        Assert.Equal(["a", "b"], meta.Tags);
        Assert.True(meta.Pinned);
        Assert.Equal("#abc", meta.Color);
        Assert.Equal("alice", meta.Owner);
        Assert.False(meta.Archived);
        Assert.False(meta.Deleted);
        Assert.Equal(ts, meta.CreatedAt);
        Assert.Equal(ts, meta.UpdatedAt);
    }

    [Fact]
    public void ParseFrontmatterOnly_MissingOptionalFields_UsesDefaults()
    {
        var raw = "---\nid: min-id\ntitle: \"Min\"\ntags: []\npinned: false\ncolor: \"\"\n---\nBody";
        using var ms = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(raw));
        var before = DateTime.UtcNow.AddSeconds(-1);
        var meta = _sut.ParseFrontmatterOnly(ms);

        Assert.Equal("min-id", meta.Id);
        Assert.Equal(string.Empty, meta.Owner);
        Assert.False(meta.Archived);
        Assert.False(meta.Deleted);
        Assert.True(meta.CreatedAt >= before);
    }

    [Fact]
    public void ParseFrontmatterOnly_DoesNotReadBody()
    {
        // Body contains only non-ASCII content to detect if it's read accidentally.
        var raw = "---\nid: nb\ntitle: \"No Body\"\ntags: []\npinned: false\ncolor: \"\"\n---\n\x01\x02\x03";
        using var ms = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(raw));
        var meta = _sut.ParseFrontmatterOnly(ms);
        Assert.Equal("nb", meta.Id);  // parsed fine without touching body
    }

    [Fact]
    public void ParseFrontmatterOnly_MissingOpeningDelimiter_Throws()
    {
        var raw = "id: x\ntitle: \"T\"\n---\n";
        using var ms = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(raw));
        Assert.Throws<FormatException>(() => _sut.ParseFrontmatterOnly(ms));
    }

    [Fact]
    public void ParseFrontmatterOnly_RoundTripWithSerializeNote()
    {
        var ts   = new DateTime(2026, 5, 15, 8, 0, 0, DateTimeKind.Utc);
        var note = MakeNote(id: "rt1", title: "Round-trip", tags: ["x"], pinned: true,
                            color: "#123abc", content: "body content", createdAt: ts, updatedAt: ts);
        var serialized = _sut.SerializeNote(note);
        using var ms = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(serialized));
        var meta = _sut.ParseFrontmatterOnly(ms);

        Assert.Equal(note.Id, meta.Id);
        Assert.Equal(note.Title, meta.Title);
        Assert.Equal(note.Tags, meta.Tags);
        Assert.Equal(note.Pinned, meta.Pinned);
        Assert.Equal(note.Color, meta.Color);
        Assert.Equal(note.CreatedAt, meta.CreatedAt);
        Assert.Equal(note.UpdatedAt, meta.UpdatedAt);
    }

    // Builds a complete raw file with frontmatter and empty content.
    private static string MinimalRaw(
        string id = "x",
        string title = "\"T\"",
        string tags = "[]",
        string pinned = "false",
        string color = "\"\"") =>
        $"---\nid: {id}\ntitle: {title}\ntags: {tags}\npinned: {pinned}\ncolor: {color}\n---\n";
}
