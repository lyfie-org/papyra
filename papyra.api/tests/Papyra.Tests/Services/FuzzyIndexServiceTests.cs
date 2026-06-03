using Papyra.Api.Services;

namespace Papyra.Tests.Services;

public sealed class FuzzyIndexServiceTests
{
    private readonly FuzzyIndexService _sut = new();

    // ── Upsert / Query ─────────────────────────────────────────────────────────

    [Fact]
    public void Query_ExactTitle_ReturnsNote()
    {
        _sut.Upsert("n1", "Meeting Notes", []);
        Assert.Contains(_sut.Query("Meeting Notes"), id => id == "n1");
    }

    [Fact]
    public void Query_PartialTitle_ReturnsNote()
    {
        _sut.Upsert("n2", "Project Proposal", []);
        Assert.Contains(_sut.Query("Proposal"), id => id == "n2");
    }

    [Fact]
    public void Query_ExactTag_ReturnsNote()
    {
        _sut.Upsert("n3", "Title", ["important"]);
        Assert.Contains(_sut.Query("important"), id => id == "n3");
    }

    [Fact]
    public void Query_UnrelatedQuery_DoesNotReturnNote()
    {
        _sut.Upsert("n4", "Baking Recipes", ["cooking"]);
        Assert.DoesNotContain(_sut.Query("spacecraft"), id => id == "n4");
    }

    [Fact]
    public void Query_EmptyString_ReturnsEmpty()
    {
        _sut.Upsert("n5", "Some Title", []);
        Assert.Empty(_sut.Query(""));
        Assert.Empty(_sut.Query("   "));
    }

    [Fact]
    public void Query_EmptyIndex_ReturnsEmpty()
    {
        Assert.Empty(_sut.Query("anything"));
    }

    [Fact]
    public void Query_LimitRespected()
    {
        for (int i = 0; i < 20; i++)
            _sut.Upsert($"note{i}", "Common Shared Text", []);
        var results = _sut.Query("Common", limit: 5);
        Assert.True(results.Count <= 5);
    }

    // ── Remove ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Remove_NoteNoLongerReturned()
    {
        _sut.Upsert("r1", "Ephemeral Note", []);
        Assert.Contains(_sut.Query("Ephemeral"), id => id == "r1");
        _sut.Remove("r1");
        Assert.DoesNotContain(_sut.Query("Ephemeral"), id => id == "r1");
    }

    [Fact]
    public void Remove_NonExistentId_NoException()
    {
        _sut.Remove("does-not-exist");  // must not throw
    }

    // ── Update (upsert replaces) ───────────────────────────────────────────────

    [Fact]
    public void Upsert_SameId_OldTokensReplaced()
    {
        _sut.Upsert("u1", "Old Title", []);
        _sut.Upsert("u1", "New Headline", []);
        // Old title tokens no longer return this note
        Assert.DoesNotContain(_sut.Query("Old Title"), id => id == "u1");
        // New title tokens work
        Assert.Contains(_sut.Query("Headline"), id => id == "u1");
    }

    // ── Seed ───────────────────────────────────────────────────────────────────

    [Fact]
    public void Seed_PopulatesIndexFromNotes()
    {
        var svc = new FuzzyIndexService();
        var metas = new[]
        {
            new Papyra.Api.Models.NoteMetadata("s1","Budget Report",[],false,"","",false,false,DateTime.UtcNow,DateTime.UtcNow),
            new Papyra.Api.Models.NoteMetadata("s2","Travel Plans",["vacation"],false,"","",false,false,DateTime.UtcNow,DateTime.UtcNow),
        };
        svc.Seed(metas);
        Assert.Contains(svc.Query("Budget"), id => id == "s1");
        Assert.Contains(svc.Query("vacation"), id => id == "s2");
    }

    // ── Trigram internals (via Query behavior) ─────────────────────────────────

    [Fact]
    public void Query_ShortQuery_StillMatches()
    {
        _sut.Upsert("q1", "API Design", []);
        // "api" is stored as an exact word token — matches without needing trigrams
        Assert.Contains(_sut.Query("api"), id => id == "q1");
    }

    [Fact]
    public void Query_MultipleNotes_RanksHigherMatchFirst()
    {
        _sut.Upsert("high", "Rocket Engine Design", []);
        _sut.Upsert("low",  "Ancient History Book", []);
        var results = _sut.Query("Rocket Engine").ToList();
        var highIdx = results.IndexOf("high");
        var lowIdx  = results.IndexOf("low");
        // "high" must be ranked above "low" (or "low" not present at all)
        Assert.True(highIdx >= 0, "Expected 'high' note to appear in results");
        Assert.True(lowIdx < 0 || highIdx < lowIdx, "Expected 'high' ranked before 'low'");
    }
}
