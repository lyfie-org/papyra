using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class SmartCollectionEvaluatorTests
{
    private static Note Sample() => new()
    {
        Id = "n1",
        Title = "Q3 Budget",
        Tags = ["work", "finance"],
        Color = "#7aaa8a",
        Pinned = true,
        Kind = "note",
        Body = "advertising spend review",
    };

    [Fact]
    public void All_RequiresEveryCondition()
    {
        var note = Sample();
        var match = new SmartRules("all", [new SmartRule("tag", "work"), new SmartRule("color", "#7aaa8a")]);
        var miss = new SmartRules("all", [new SmartRule("tag", "work"), new SmartRule("color", "#ffffff")]);

        Assert.True(SmartCollectionEvaluator.Matches(note, match));
        Assert.False(SmartCollectionEvaluator.Matches(note, miss));
    }

    [Fact]
    public void Any_NeedsOnlyOneCondition()
    {
        var rules = new SmartRules("any", [new SmartRule("tag", "nope"), new SmartRule("pinned", "true")]);
        Assert.True(SmartCollectionEvaluator.Matches(Sample(), rules));
    }

    [Fact]
    public void Text_MatchesTitleOrBody_CaseInsensitively()
    {
        Assert.True(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", [new SmartRule("text", "ADVERTISING")])));
        Assert.True(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", [new SmartRule("text", "budget")])));
        Assert.False(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", [new SmartRule("text", "zzyzx")])));
    }

    [Fact]
    public void EmptyOrUnknownRules_MatchNothing()
    {
        Assert.False(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", [])));
        Assert.False(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", null)));
        Assert.False(SmartCollectionEvaluator.Matches(Sample(), new SmartRules("all", [new SmartRule("bogus", "x")])));
    }
}
