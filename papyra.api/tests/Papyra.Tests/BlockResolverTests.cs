using Papyra.Api.Storage;

namespace Papyra.Tests;

// Phase 15.1. The editor stamps ` ^id` onto the last line of paragraphs,
// headings and quotes; these pin the reader against that shape, including the
// cases where a `^id`-looking sequence must NOT be treated as an anchor.
public sealed class BlockResolverTests
{
    private const string Body = """
        # Heading one ^a1b2c3d4

        A paragraph that carries an anchor. ^deadbeef

        A paragraph with no anchor at all.

        > Quoted line ^q7q7q7q7
        """;

    [Fact]
    public void Anchors_FindsEveryStampedBlock_InDocumentOrder()
    {
        var ids = BlockResolver.Anchors(Body).Select(a => a.BlockId).ToArray();
        Assert.Equal(["a1b2c3d4", "deadbeef", "q7q7q7q7"], ids);
    }

    [Fact]
    public void Anchors_StripsTheSuffixFromTheBlockText()
    {
        var anchor = BlockResolver.Anchors(Body).Single(a => a.BlockId == "deadbeef");
        Assert.Equal("A paragraph that carries an anchor.", anchor.Text);
    }

    [Fact]
    public void Resolve_ReturnsOnlyThatBlock()
    {
        var text = BlockResolver.Resolve(Body, "q7q7q7q7");
        Assert.Equal("> Quoted line", text);
        // The point of the whole feature: nothing else comes with it.
        Assert.DoesNotContain("Heading one", text);
        Assert.DoesNotContain("no anchor at all", text);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("")]
    [InlineData(null)]
    public void Resolve_ReturnsNullForAnAbsentAnchor(string? blockId)
        => Assert.Null(BlockResolver.Resolve(Body, blockId));

    [Fact]
    public void Resolve_IsCaseSensitive()
        => Assert.Null(BlockResolver.Resolve(Body, "DEADBEEF"));

    [Fact]
    public void Anchors_IgnoresAnchorLookalikesInsideFencedCode()
    {
        var body = """
            Real block. ^realone1

            ```sh
            git rev-parse HEAD ^fakeone1
            ```

            ~~~
            echo hi ^fakeone2
            ~~~
            """;
        var ids = BlockResolver.Anchors(body).Select(a => a.BlockId).ToArray();
        Assert.Equal(["realone1"], ids);
        Assert.Null(BlockResolver.Resolve(body, "fakeone1"));
        Assert.Null(BlockResolver.Resolve(body, "fakeone2"));
    }

    [Fact]
    public void Anchors_IgnoresABareAnchorWithNoBlockText()
        => Assert.Empty(BlockResolver.Anchors("^orphan01"));

    [Fact]
    public void Anchors_HandlesCrlfBodies()
    {
        var ids = BlockResolver.Anchors("First. ^aaaa1111\r\n\r\nSecond. ^bbbb2222")
            .Select(a => a.BlockId).ToArray();
        Assert.Equal(["aaaa1111", "bbbb2222"], ids);
    }

    [Fact]
    public void Resolve_TakesTheFirstOfADuplicatedId()
    {
        var body = "First copy. ^dupe0001\n\nSecond copy. ^dupe0001";
        Assert.Equal("First copy.", BlockResolver.Resolve(body, "dupe0001"));
    }

    [Theory]
    [InlineData("a1b2c3d4")]
    [InlineData("Block_Id-1")]
    public void IsValidBlockId_AcceptsTheTransformerShape(string id)
        => Assert.True(BlockResolver.IsValidBlockId(id));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("-leading-dash")]
    [InlineData("has space")]
    [InlineData("has/slash")]
    [InlineData("../../escape")]
    [InlineData("emoji🎉")]
    public void IsValidBlockId_RejectsAnythingElse(string? id)
        => Assert.False(BlockResolver.IsValidBlockId(id));

    [Fact]
    public void IsValidBlockId_RejectsOverlongIds()
        => Assert.False(BlockResolver.IsValidBlockId(new string('a', 65)));

    // The anchor is an invisible node, so the caret can sit after it: typing at
    // the end of a block leaves "text ^id more text". Resolution must survive it,
    // and the stray token must not appear in what a reader is served.
    [Fact]
    public void Resolve_HandlesAnAnchorLeftMidLineByTypingPastIt()
    {
        const string body = "First paragraph of the source note. ^1t835mwx More words.";
        Assert.Equal("First paragraph of the source note. More words.", BlockResolver.Resolve(body, "1t835mwx"));
    }

    [Fact]
    public void Anchors_StripEveryTokenFromTheText()
    {
        const string body = "Start ^aaaa1111 middle ^bbbb2222 end.";
        var anchor = Assert.Single(BlockResolver.Anchors(body));
        Assert.Equal("aaaa1111", anchor.BlockId);   // first wins, as the editor de-dupes
        Assert.Equal("Start middle end.", anchor.Text);
        Assert.DoesNotContain("^", anchor.Text);
    }

    [Fact]
    public void Anchors_DoesNotMatchACaretGluedToAWord()
    {
        // "x^2" is exponentiation in prose, not an anchor.
        Assert.Empty(BlockResolver.Anchors("The area scales with x^2 for a square."));
    }

    // ── finding a block that never carried an anchor ──────────────────────────
    // A mention written outside Papyra's editor has no `^id` to point at, so the
    // grant records the line's text instead. Resolving it must stay a *lookup in
    // the author's live note* — never a copy handed back unchecked — or a block
    // the author has since reworded would keep being served.

    [Fact]
    public void ResolveLine_FindsALineThatIsStillThere()
        => Assert.Equal("Could @bea look at this?",
            BlockResolver.ResolveLine("Intro.\n\nCould @bea look at this?\n\nEnd.", "Could @bea look at this?"));

    [Fact]
    public void ResolveLine_FindsAListItem_WhichAnchorsNeverCover()
        => Assert.Equal("- ask @bea about it",
            BlockResolver.ResolveLine("- ask @bea about it\n- other", "- ask @bea about it"));

    [Fact]
    public void ResolveLine_ReturnsNullOnceTheLineIsReworded()
        => Assert.Null(BlockResolver.ResolveLine("Could @bea look at the new one?", "Could @bea look at this?"));

    [Fact]
    public void ResolveLine_ReturnsNullOnceTheLineIsGone()
        => Assert.Null(BlockResolver.ResolveLine("Something else entirely.", "Could @bea look at this?"));

    [Fact]
    public void ResolveLine_IgnoresAMatchInsideFencedCode()
        => Assert.Null(BlockResolver.ResolveLine("```\nCould @bea look at this?\n```", "Could @bea look at this?"));

    [Fact]
    public void ResolveLine_MatchesAcrossAnAnchorTheAuthorHasSinceGained()
    {
        // Opening the note in Papyra stamps anchors. The stored line was captured
        // before that, so the match has to be against the cleaned line, not the raw one.
        Assert.Equal("Could @bea look at this?",
            BlockResolver.ResolveLine("Could @bea look at this? ^ping0001", "Could @bea look at this?"));
    }

    [Fact]
    public void ResolveLine_RefusesAnEmptyOrMissingReference()
    {
        Assert.Null(BlockResolver.ResolveLine("Anything at all.", null));
        Assert.Null(BlockResolver.ResolveLine("Anything at all.", "   "));
    }

    [Fact]
    public void Lines_SkipsFencedCodeAndBlankLines()
    {
        const string body = "First.\n\n```\nfenced @bea\n```\n\n- item";
        Assert.Equal(["First.", "- item"], BlockResolver.Lines(body));
    }
}
