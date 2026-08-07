namespace Papyra.Api.Storage;

// Groups note timestamps into a year → month → day → count tree for the knowledge
// heatmap. Pure + unit-testable; the endpoint feeds it the live vault's timestamps.
public static class TemporalActivity
{
    public static Dictionary<int, Dictionary<int, Dictionary<int, int>>> Group(IEnumerable<DateTime> timestamps)
    {
        var tree = new Dictionary<int, Dictionary<int, Dictionary<int, int>>>();
        foreach (var ts in timestamps)
        {
            var months = tree.TryGetValue(ts.Year, out var m) ? m : tree[ts.Year] = new();
            var days = months.TryGetValue(ts.Month, out var d) ? d : months[ts.Month] = new();
            days[ts.Day] = days.GetValueOrDefault(ts.Day) + 1;
        }
        return tree;
    }
}
