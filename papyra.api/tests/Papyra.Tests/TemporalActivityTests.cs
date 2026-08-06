using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class TemporalActivityTests
{
    [Fact]
    public void Group_CountsPerDay_NestedByYearMonthDay()
    {
        var tree = TemporalActivity.Group(
        [
            new DateTime(2026, 8, 6, 9, 0, 0),
            new DateTime(2026, 8, 6, 18, 0, 0),  // same day → count 2
            new DateTime(2026, 8, 7, 1, 0, 0),
            new DateTime(2025, 12, 31, 23, 0, 0),
        ]);

        Assert.Equal(2, tree[2026][8][6]);
        Assert.Equal(1, tree[2026][8][7]);
        Assert.Equal(1, tree[2025][12][31]);
    }

    [Fact]
    public void Group_Empty_IsEmpty()
    {
        Assert.Empty(TemporalActivity.Group([]));
    }
}
