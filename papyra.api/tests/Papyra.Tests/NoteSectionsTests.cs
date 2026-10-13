using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>Editing a note by its headings (PATCH /api/notes/{id}/sections).</summary>
public sealed class NoteSectionsTests
{
    private const string Trip = """
        # Japan

        Intro

        ## Day 1 ^d1

        Tokyo

        ### Evening

        Shibuya

        ## Day 2

        Kyoto
        """;

    private static string Apply(string body, params SectionOp[] ops)
    {
        var (result, error) = NoteSections.Apply(body, ops);
        Assert.Null(error);
        return result!;
    }

    private static SectionOp Op(string op, string? heading, string? content = null, int? level = null, int? occurrence = null) =>
        new(op, heading, level, occurrence, content);

    [Fact]
    public void OutlineListsHeadingsButNotOnesInCode()
    {
        var outline = NoteSections.Outline("# A\n\n```\n# not a heading\n```\n\n## B ##\n\n## B");
        Assert.Equal([new SectionHeading("A", 1, 1), new SectionHeading("B", 2, 1), new SectionHeading("B", 2, 2)], outline);
    }

    [Fact]
    public void ReplaceSwapsEverythingUnderTheHeading()
    {
        Assert.Equal("# Japan\n\nIntro\n\n## Day 1 ^d1\n\nOsaka instead\n\n## Day 2\n\nKyoto",
            Apply(Trip, Op("replace", "Day 1", "Osaka instead")));
    }

    [Fact]
    public void AppendLandsBeforeSubsectionsAndInsertAfterBeyondThem()
    {
        Assert.Contains("Tokyo\n\nTeamLab\n\n### Evening", Apply(Trip, Op("append", "day 1", "TeamLab")));
        Assert.Contains("Shibuya\n\n## Day 1.5\n\nHakone\n\n## Day 2",
            Apply(Trip, Op("insertAfter", "## Day 1", "## Day 1.5\n\nHakone")));
    }

    [Fact]
    public void PrependInsertBeforeAndWholeNoteEdges()
    {
        Assert.Contains("## Day 2\n\nTrain at 8\n\nKyoto", Apply(Trip, Op("prepend", "Day 2", "Train at 8")));
        Assert.Contains("Intro\n\n## Day 0\n\nFlight\n\n## Day 1", Apply(Trip, Op("insertBefore", "Day 1", "## Day 0\n\nFlight")));
        Assert.EndsWith("Kyoto\n\nPacking list", Apply(Trip, Op("append", null, "Packing list")));
        Assert.StartsWith("Draft\n\n# Japan", Apply(Trip, Op("prepend", null, "Draft")));
        Assert.Equal("Hello", Apply("", Op("append", null, "Hello")));
    }

    [Fact]
    public void DeleteRemovesTheSectionWithoutLeavingAGap()
    {
        Assert.Equal("# Japan\n\nIntro\n\n## Day 2\n\nKyoto", Apply(Trip, Op("delete", "Day 1")));
        Assert.Equal("# Japan\n\nIntro\n\n## Day 1 ^d1\n\nTokyo\n\n### Evening\n\nShibuya",
            Apply(Trip, Op("delete", "Day 2")));
    }

    [Fact]
    public void OpsApplyInOrderAndKeepCrlf()
    {
        var crlf = Trip.Replace("\n", "\r\n");
        var result = Apply(crlf, Op("append", null, "## Day 3\n\nNara"), Op("append", "Day 3", "Deer park"));
        Assert.EndsWith("Kyoto\r\n\r\n## Day 3\r\n\r\nNara\r\n\r\nDeer park", result);
    }

    [Fact]
    public void MissingAmbiguousAndMalformedOpsSayWhy()
    {
        Assert.Contains("\"Day 1\"", NoteSections.Apply(Trip, [Op("replace", "Day 9", "x")]).Error);
        Assert.Contains("occurrence", NoteSections.Apply("## B\n\n## B", [Op("replace", "B", "x")]).Error);
        Assert.Equal("## B\n\n## B\n\nsecond", Apply("## B\n\n## B", Op("append", "B", "second", occurrence: 2)));
        Assert.Contains("\"op\"", NoteSections.Apply(Trip, [Op("rewrite", "Day 1", "x")]).Error);
        Assert.Contains("content", NoteSections.Apply(Trip, [Op("append", "Day 1")]).Error);
        Assert.Contains("heading", NoteSections.Apply(Trip, [Op("delete", null)]).Error);
        Assert.NotNull(NoteSections.Apply(Trip, []).Error);
        Assert.NotNull(NoteSections.Apply(Trip, [Op("replace", "Day 1", "x", level: 3)]).Error);
        Assert.Equal("## Week\n\n### Mon\n\nx\n\nz\n\n## Mon\n\ny",
            Apply("## Week\n\n### Mon\n\nx\n\n## Mon\n\ny", Op("append", "Mon", "z", level: 3)));
    }
}
