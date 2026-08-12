using Papyra.Api.Storage;

namespace Papyra.Tests;

// Phase 15.2. Mention parsing decides who gets pinged and which block travels
// with the ping, so these pin the boundaries: what counts as a mention, and
// which block a mention belongs to.
public sealed class MentionDeliveryTests
{
    [Fact]
    public void Mentions_FindsEachDistinctNameOnce_InFirstSeenOrder()
    {
        var names = MentionDeliveryService.Mentions(
            "Ping @bea and @cal, then @bea again.");
        Assert.Equal(["bea", "cal"], names);
    }

    [Theory]
    [InlineData("Start @bea here.")]      // start of line
    [InlineData("(@bea) in parens")]      // after a bracket
    [InlineData("[@bea] in brackets")]
    public void Mentions_AcceptsAMentionAtATokenBoundary(string body)
        => Assert.Contains("bea", MentionDeliveryService.Mentions(body));

    [Theory]
    [InlineData("write to bea@example.com")]   // an email address is not a ping
    [InlineData("the price is 12@each")]       // glued to a word
    [InlineData("no mention at all")]
    [InlineData("")]
    [InlineData(null)]
    public void Mentions_IgnoresNonMentions(string? body)
        => Assert.Empty(MentionDeliveryService.Mentions(body));

    [Fact]
    public void Mentions_DoesNotSwallowTrailingPunctuation()
    {
        // "@bea." is a mention of bea, not of "bea."
        Assert.Equal(["bea"], MentionDeliveryService.Mentions("Ask @bea."));
    }

    [Fact]
    public void BlockForMention_ReturnsTheAnchorOfTheMentioningBlock()
    {
        const string body = """
            Private paragraph nobody else should see. ^priv0001

            Can @bea take the migration? ^ping0001

            Another private line. ^priv0002
            """;
        Assert.Equal("ping0001", MentionDeliveryService.BlockForMention(body, "bea"));
    }

    [Fact]
    public void BlockForMention_IsCaseInsensitiveOnTheUsername()
        => Assert.Equal("ping0001",
            MentionDeliveryService.BlockForMention("Hi @Bea there. ^ping0001", "bea"));

    [Fact]
    public void BlockForMention_ReturnsNullWhenTheBlockCarriesNoAnchor()
    {
        // List items are not stampable, so there is no single block to deliver —
        // and delivering the whole note instead is exactly what must not happen.
        Assert.Null(MentionDeliveryService.BlockForMention("- ask @bea about it\n- other", "bea"));
    }

    [Fact]
    public void BlockForMention_ReturnsNullForSomeoneNotMentioned()
        => Assert.Null(MentionDeliveryService.BlockForMention("Hi @bea. ^ping0001", "cal"));

    [Fact]
    public void BlockForMention_PicksTheFirstMentioningBlockWhenThereAreSeveral()
    {
        const string body = "First ping @bea. ^one00001\n\nSecond ping @bea. ^two00002";
        Assert.Equal("one00001", MentionDeliveryService.BlockForMention(body, "bea"));
    }

    // ── inbox size cap ────────────────────────────────────────────────────────

    [Fact]
    public void TrimToNewestEntries_KeepsTheNewestAndDropsTheOldest()
    {
        var body = string.Join("\n\n", Enumerable.Range(1, 10).Select(i => $"entry {i}"));
        var trimmed = MentionDeliveryService.TrimToNewestEntries(body, 3);

        Assert.Equal("entry 8\n\nentry 9\n\nentry 10", trimmed);
    }

    [Fact]
    public void TrimToNewestEntries_LeavesAShortInboxUntouched()
    {
        const string body = "entry 1\n\nentry 2";
        Assert.Equal(body, MentionDeliveryService.TrimToNewestEntries(body, MentionDeliveryService.MaxInboxEntries));
    }

    [Fact]
    public void TrimToNewestEntries_KeepsAMultiLineEntryWhole()
    {
        // A real entry is two lines: the reference and its provenance line. The
        // split must be on the blank line between entries, not on every newline.
        const string body = "![[a#^one]]\n— @ana · date\n\n![[b#^two]]\n— @cal · date";
        var trimmed = MentionDeliveryService.TrimToNewestEntries(body, 1);

        Assert.Equal("![[b#^two]]\n— @cal · date", trimmed);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public void TrimToNewestEntries_HandlesAnEmptyInbox(string? body)
        => Assert.Equal(body ?? string.Empty,
            MentionDeliveryService.TrimToNewestEntries(body ?? string.Empty, 10));
}
