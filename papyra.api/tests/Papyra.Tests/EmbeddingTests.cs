using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class EmbeddingTests
{
    // ── Chunking ────────────────────────────────────────────────────────────────

    [Fact]
    public void Chunk_PacksParagraphsUpToTheBudget()
    {
        var body = string.Join("\n\n", Enumerable.Repeat("Short paragraph.", 4));
        var chunks = TextChunker.Chunk(body, maxChars: 100);

        Assert.NotEmpty(chunks);
        Assert.All(chunks, c => Assert.True(c.Length <= 100, $"chunk too long: {c.Length}"));
        // Nothing is dropped.
        Assert.Equal(4, chunks.Sum(c => c.Split("Short paragraph.").Length - 1));
    }

    [Fact]
    public void Chunk_SplitsAnOversizedParagraph()
    {
        var body = string.Join(" ", Enumerable.Repeat("Sentence about budgets.", 40));
        var chunks = TextChunker.Chunk(body, maxChars: 120);

        Assert.True(chunks.Count > 1);
        Assert.All(chunks, c => Assert.True(c.Length <= 120));
    }

    [Fact]
    public void Chunk_EmptyBody_YieldsNothing()
    {
        Assert.Empty(TextChunker.Chunk(""));
        Assert.Empty(TextChunker.Chunk(null));
        Assert.Empty(TextChunker.Chunk("   \n\n  "));
    }

    // ── Vector maths + storage round-trip ───────────────────────────────────────

    [Fact]
    public void Cosine_IsOneForIdentical_ZeroForOrthogonal()
    {
        Assert.Equal(1.0, EmbeddingService.Cosine([1, 0, 0], [1, 0, 0]), 6);
        Assert.Equal(0.0, EmbeddingService.Cosine([1, 0], [0, 1]), 6);
        // Direction matters, magnitude doesn't.
        Assert.Equal(1.0, EmbeddingService.Cosine([1, 2, 3], [2, 4, 6]), 6);
    }

    [Fact]
    public void Cosine_MismatchedOrEmpty_ScoresZero()
    {
        Assert.Equal(0.0, EmbeddingService.Cosine([1, 2], [1, 2, 3]));
        Assert.Equal(0.0, EmbeddingService.Cosine([], []));
        Assert.Equal(0.0, EmbeddingService.Cosine([0, 0], [1, 1]));
    }

    [Fact]
    public void Vector_RoundTripsThroughBytes()
    {
        float[] original = [0.5f, -1.25f, 3.0e-3f, 42f];
        Assert.Equal(original, EmbeddingService.ToFloats(EmbeddingService.ToBytes(original)));
    }
}
